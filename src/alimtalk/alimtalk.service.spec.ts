import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
  let logLog: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

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
    client = {
      sendMessage: jest.fn().mockResolvedValue({
        code: 1000,
        description: 'success',
        refkey: 'ref',
        messagekey: 'mk-1',
      }),
    };
    findUnique = jest.fn().mockResolvedValue(template);
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
          useValue: { notificationTemplate: { findUnique } },
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
