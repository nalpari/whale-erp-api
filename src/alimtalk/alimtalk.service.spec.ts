import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
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
  let render: jest.Mock;
  let logLog: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

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
    render = jest.fn().mockResolvedValue({
      title: null,
      body: '임시 비밀번호: pw-secret',
      kakaoTemplateCode: 'WHALEERP0005',
    });
    const module = await Test.createTestingModule({
      providers: [
        AlimtalkService,
        { provide: BizppurioClient, useValue: client },
        {
          provide: BIZPPURIO_CONFIG,
          useValue: { account: 'whale', senderKey: 'sender-key' },
        },
        { provide: NotificationTemplatesService, useValue: { render } },
      ],
    }).compile();
    service = module.get(AlimtalkService);
    // 모듈 초기화 로그는 세지 않는다.
    logLog.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  const vars = { password: 'pw-secret' };
  const sent = () =>
    (client.sendMessage.mock.calls[0] as [BizppurioMessage])[0];

  it('ALIMTALK 템플릿을 채워 카카오 템플릿 코드로 보낸다', async () => {
    await service.send('TALK_TEMP_PASSWORD', '010-1234-5678', vars);

    expect(render).toHaveBeenCalledWith('TALK_TEMP_PASSWORD', 'ALIMTALK', vars);
    const { refkey, ...request } = sent();
    expect(refkey).toMatch(/^[0-9a-f]{20}$/);
    expect(request).toEqual({
      account: 'whale',
      type: 'at',
      to: '01012345678',
      content: {
        at: {
          senderkey: 'sender-key',
          // 비즈뿌리오는 우리 코드(template_code)가 아니라 카카오에 등록한 코드를 안다.
          templatecode: 'WHALEERP0005',
          message: '임시 비밀번호: pw-secret',
        },
      },
    });
  });

  it('refKey 와 messageKey 를 돌려준다', async () => {
    const result = await service.send(
      'TALK_TEMP_PASSWORD',
      '01012345678',
      vars,
    );

    expect(result).toEqual({ refKey: sent().refkey, messageKey: 'mk-1' });
  });

  it('템플릿을 채우지 못하면 보내지 않고 그 오류를 던진다', async () => {
    const error = new Error('템플릿 NOPE: 템플릿이 없습니다');
    render.mockRejectedValue(error);

    await expect(service.send('NOPE', '01012345678', vars)).rejects.toBe(error);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['', '010-123', '0101234567890', '+82 10-1234-5678'])(
    '휴대폰 번호가 아니면(%s) 템플릿을 읽지도 않고 던진다',
    async (to) => {
      const error = await service
        .send('TALK_TEMP_PASSWORD', to, vars)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      // 오류 메시지는 예외 필터 로그로 나갈 수 있어 번호를 가린다.
      if (to.length >= 8)
        expect((error as Error).message).not.toContain(to.replace(/\D/g, ''));
      expect(render).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('접수되면 번호를 가리고 본문은 남기지 않은 채 로그한다', async () => {
    await service.send('TALK_TEMP_PASSWORD', '010-1234-5678', vars);

    expect(logLog).toHaveBeenCalledTimes(1);
    const [line] = logLog.mock.calls[0] as [string];
    expect(line).toContain('TALK_TEMP_PASSWORD');
    expect(line).toContain('WHALEERP0005');
    expect(line).toContain('mk-1');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('01012345678');
    expect(line).not.toContain('pw-secret');
  });

  it('비즈뿌리오 오류는 코드를 남기고 그대로 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);

    await expect(
      service.send('TALK_TEMP_PASSWORD', '01012345678', vars),
    ).rejects.toBe(error);
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('code=2000');
    // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
    expect(line).toContain('bad');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('pw-secret');
  });
});
