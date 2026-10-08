import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MASK } from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import { AlimtalkService } from './alimtalk.service';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG } from './bizppurio.config';

describe('AlimtalkService', () => {
  let service: AlimtalkService;
  let client: { sendMessage: jest.Mock };
  let findUnique: jest.Mock;
  let create: jest.Mock;
  let logLog: jest.SpyInstance;
  let logWarn: jest.SpyInstance;
  let logError: jest.SpyInstance;

  const template = {
    templateCode: 'TALK_SCHEDULE',
    channel: 'ALIMTALK',
    isActive: true,
    title: null,
    body: '#{name}님, #{date} 근무가 변경되었습니다.',
    variables: [
      { name: 'name', isRequired: true },
      { name: 'date', isRequired: true },
    ],
    kakaoTemplateCode: 'KAKAO_SCHEDULE_01',
  };
  const input = {
    templateCode: 'TALK_SCHEDULE',
    to: '010-1234-5678',
    variables: { name: '홍길동', date: '10/7' },
  };

  beforeEach(async () => {
    logLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    client = {
      sendMessage: jest.fn().mockResolvedValue({
        code: 1000,
        description: 'success',
        refkey: 'ref',
        messagekey: 'mk-1',
      }),
    };
    findUnique = jest.fn().mockResolvedValue(template);
    create = jest.fn().mockResolvedValue({});
    const module = await Test.createTestingModule({
      providers: [
        AlimtalkService,
        { provide: BizppurioClient, useValue: client },
        {
          provide: BIZPPURIO_CONFIG,
          useValue: { account: 'whale', senderKey: 'sender-key' },
        },
        {
          provide: PrismaService,
          useValue: {
            notificationTemplate: { findUnique },
            alimtalkSendLog: { create },
          },
        },
      ],
    }).compile();
    service = module.get(AlimtalkService);
    // 모듈 초기화 로그는 세지 않는다.
    logLog.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  const sent = () =>
    (client.sendMessage.mock.calls[0] as [BizppurioMessage])[0];
  /** 기록된 alimtalk_send_logs 한 행 */
  const logged = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it('접수되면 가린 본문으로 SUCCEEDED 이력을 남긴다', async () => {
    const { refKey } = await service.send({
      ...input,
      maskedVariables: ['date'],
      related: { type: 'INVITATION', id: 7 },
      sentBy: 3,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        templateCode: 'TALK_SCHEDULE',
        kakaoTemplateCode: 'KAKAO_SCHEDULE_01',
        toPhone: '01012345678',
        relatedType: 'INVITATION',
        relatedId: 7,
        body: `홍길동님, ${MASK} 근무가 변경되었습니다.`,
        result: 'SUCCEEDED',
        failureReason: null,
        refKey,
        messageKey: 'mk-1',
        sentBy: 3,
      },
    });
  });

  it('관련 업무 · 처리자를 넘기지 않으면 NULL 로 남긴다', async () => {
    await service.send(input);

    expect(logged()).toMatchObject({
      relatedType: null,
      relatedId: null,
      sentBy: null,
      body: '홍길동님, 10/7 근무가 변경되었습니다.',
    });
  });

  it('비즈뿌리오가 실패하면 FAILED 이력을 남기고 원래 예외를 다시 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);

    await expect(service.send(input)).rejects.toBe(error);
    expect(logged()).toMatchObject({
      result: 'FAILED',
      failureReason: 'code=2000 http=200: bad',
      messageKey: null,
    });
    expect(logged().refKey).toBe(sent().refkey);
  });

  it('code 없는 오류도 FAILED 이력을 남기고, 이력에는 메시지 전부를 둔다', async () => {
    const message = 'e'.repeat(5000);
    client.sendMessage.mockRejectedValue(new Error(message));

    await expect(service.send(input)).rejects.toThrow();
    expect(logged()).toMatchObject({
      result: 'FAILED',
      failureReason: `code=undefined http=undefined: ${message}`,
    });
  });

  it('보낸 뒤 이력 INSERT 가 실패해도 던지지 않는다 — 다시 보내게 하지 않는다', async () => {
    // Prisma 오류 메시지는 호출 인자(data)를 통째로 찍는다 — 번호와 본문이 들어 있다.
    create.mockRejectedValue(
      Object.assign(
        new Error(
          'Foreign key constraint violated: data { toPhone: "01012345678", body: "홍길동님" }',
        ),
        { name: 'PrismaClientKnownRequestError', code: 'P2003' },
      ),
    );

    await expect(
      service.send({
        ...input,
        related: { type: 'INVITATION', id: 7 },
        sentBy: 3,
      }),
    ).resolves.toMatchObject({ messageKey: 'mk-1' });
    const [line] = logError.mock.calls[0] as [string];
    expect(line).toContain('alimtalk_send_logs INSERT FAILED');
    expect(line).toContain('PrismaClientKnownRequestError');
    expect(line).toContain('code=P2003');
    expect(line).toContain('related=INVITATION:7');
    expect(line).toContain('sentBy=3');
    expect(line).not.toContain('01012345678');
    expect(line).not.toContain('홍길동');
  });

  it('비즈뿌리오 실패 뒤 이력 INSERT 도 실패하면 비즈뿌리오 예외를 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);
    create.mockRejectedValue(new Error('db down'));

    await expect(service.send(input)).rejects.toBe(error);
  });

  it('템플릿 코드로 조회해 카카오 템플릿 코드로 보낸다', async () => {
    await service.send(input);

    expect(findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'TALK_SCHEDULE' },
    });
    const { refkey, ...request } = sent();
    expect(refkey).toMatch(/^[0-9a-f]{20}$/);
    expect(request).toEqual({
      account: 'whale',
      type: 'at',
      to: '01012345678',
      content: {
        at: {
          senderkey: 'sender-key',
          templatecode: 'KAKAO_SCHEDULE_01',
          message: '홍길동님, 10/7 근무가 변경되었습니다.',
        },
      },
    });
  });

  it('본문 값은 이스케이프하지 않는다 — 알림톡은 텍스트다', async () => {
    await service.send({ ...input, variables: { name: '<A & B>', date: 'x' } });

    expect(sent().content.at.message).toBe(
      '<A & B>님, x 근무가 변경되었습니다.',
    );
  });

  it('refKey 와 messageKey 를 돌려준다', async () => {
    const result = await service.send(input);

    expect(result).toEqual({ refKey: sent().refkey, messageKey: 'mk-1' });
  });

  it('변수 값 안의 #{...} 는 다시 치환하지 않는다', async () => {
    await service.send({ ...input, variables: { name: '#{date}', date: 'x' } });

    expect(sent().content.at.message).toBe(
      '#{date}님, x 근무가 변경되었습니다.',
    );
  });

  it.each([
    ['필수 변수 누락', { name: '홍길동' }, undefined, 'date'],
    [
      '문자열이 아닌 값',
      { name: null as unknown as string, date: 'x' },
      undefined,
      'name',
    ],
    [
      '템플릿에 없는 변수',
      { ...input.variables, 오타: 'x' },
      undefined,
      '오타',
    ],
    ['템플릿에 없는 가림 이름', input.variables, ['이름'], '이름'],
  ])(
    '%s 이면 보내지 않고 던진다',
    async (_, variables, maskedVariables, name) => {
      await expect(
        service.send({ ...input, variables, maskedVariables }),
      ).rejects.toThrow(name);
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['템플릿이 없다', null, /없습니다/],
    ['사용 안 함', { ...template, isActive: false }, /사용하지 않는/],
    ['알림톡 채널이 아니다', { ...template, channel: 'EMAIL' }, /ALIMTALK/],
  ])('%s 면 보내지 않고 던진다', async (_, row, message) => {
    findUnique.mockResolvedValue(row);

    await expect(service.send(input)).rejects.toThrow(message);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['', '010-123', '0101234567890', '+82 10-1234-5678'])(
    '휴대폰 번호가 아니면(%s) 템플릿을 조회하지도 않고 던진다',
    async (to) => {
      const error = await service
        .send({ ...input, to })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      // 오류 메시지는 예외 필터 로그로 나갈 수 있어 번호를 가린다.
      if (to.length >= 8)
        expect((error as Error).message).not.toContain(to.replace(/\D/g, ''));
      expect(findUnique).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('접수되면 번호를 가리고 본문은 남기지 않은 채 로그한다', async () => {
    await service.send({
      ...input,
      variables: { name: '홍길동', date: 'secret-date' },
    });

    expect(logLog).toHaveBeenCalledTimes(1);
    const [line] = logLog.mock.calls[0] as [string];
    expect(line).toContain('TALK_SCHEDULE');
    expect(line).toContain('mk-1');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('01012345678');
    expect(line).not.toContain('secret-date');
  });

  it('비즈뿌리오 오류는 코드를 남기고 그대로 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);

    await expect(service.send(input)).rejects.toBe(error);
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('code=2000');
    // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
    expect(line).toContain('bad');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('홍길동');
  });

  it('비즈뿌리오 오류 메시지가 아주 길어도 로그는 1000자까지만 남긴다', async () => {
    client.sendMessage.mockRejectedValue(new Error('e'.repeat(5000)));

    await expect(service.send(input)).rejects.toThrow();
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('e'.repeat(1000));
    expect(line).not.toContain('e'.repeat(1001));
  });
});
