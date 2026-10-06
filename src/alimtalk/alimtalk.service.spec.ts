import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ALIMTALK_TEMPLATE_REGISTRY,
  type AlimtalkTemplate,
  type AlimtalkVariablesOf,
  type TemplateVariables,
} from './alimtalk-templates';
import { AlimtalkService, type AlimtalkSendResult } from './alimtalk.service';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG } from './bizppurio.config';

const templates: Record<string, AlimtalkTemplate> = {
  T1: { body: '#{name}님, #{date} 근무가 변경되었습니다.' },
  T2: { body: '임시 비밀번호: #{password}', title: '비밀번호 안내' },
  T3: { body: '#{toString}', title: '#{storeName} 안내' },
};

// 본문에서 변수 이름을 뽑는 타입. 변수를 빠뜨리면 컴파일이 실패해야 한다.
const typed: TemplateVariables<'#{name}님 #{date}'> = { name: 'a', date: 'b' };
// @ts-expect-error date 가 빠졌다
const missing: TemplateVariables<'#{name}님 #{date}'> = { name: 'a' };
void typed;
void missing;

// 레지스트리와 같은 선언(`as const satisfies`)을 거쳐도 본문이 리터럴로 남아야 한다.
// `satisfies` 만 쓰면 body 가 string 으로 넓어져 아래 누락이 컴파일된다.
const registry = {
  T9: { body: '#{storeName} #{joinUrl}' },
} as const satisfies Record<string, AlimtalkTemplate>;
// @ts-expect-error joinUrl 이 빠졌다
const missingViaRegistry: TemplateVariables<(typeof registry)['T9']['body']> = {
  storeName: 'a',
};
void registry;
void missingViaRegistry;

// 강조표기형 제목의 변수도 호출부가 채워야 한다.
const titled = {
  T8: { body: '#{name}님', title: '#{storeName} 안내' },
} as const satisfies Record<string, AlimtalkTemplate>;
// @ts-expect-error 제목의 storeName 이 빠졌다
const missingTitleVar: AlimtalkVariablesOf<(typeof titled)['T8']> = {
  name: 'a',
};
void titled;
void missingTitleVar;

describe('AlimtalkService', () => {
  let service: AlimtalkService;
  let client: { sendMessage: jest.Mock };
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
    const module = await Test.createTestingModule({
      providers: [
        AlimtalkService,
        { provide: BizppurioClient, useValue: client },
        {
          provide: BIZPPURIO_CONFIG,
          useValue: { account: 'whale', senderKey: 'sender-key' },
        },
        { provide: ALIMTALK_TEMPLATE_REGISTRY, useValue: templates },
      ],
    }).compile();
    service = module.get(AlimtalkService);
    // 모듈 초기화 로그는 세지 않는다.
    logLog.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  // 테스트용 레지스트리는 실제 ALIMTALK_TEMPLATES 와 코드가 달라 타입을 우회한다.
  type LooseSend = (
    code: string,
    to: string,
    variables: Record<string, string>,
  ) => Promise<AlimtalkSendResult>;
  const send: LooseSend = (code, to, variables) =>
    (service as unknown as { send: LooseSend }).send(code, to, variables);
  const sent = () =>
    (client.sendMessage.mock.calls[0] as [BizppurioMessage])[0];

  it('변수를 치환해 알림톡 요청을 만든다', async () => {
    await send('T1', '010-1234-5678', { name: '홍길동', date: '10/7' });

    const { refkey, ...request } = sent();
    expect(refkey).toMatch(/^[0-9a-f]{20}$/);
    expect(request).toEqual({
      account: 'whale',
      type: 'at',
      to: '01012345678',
      content: {
        at: {
          senderkey: 'sender-key',
          templatecode: 'T1',
          message: '홍길동님, 10/7 근무가 변경되었습니다.',
        },
      },
    });
  });

  it('템플릿에 제목이 있으면 함께 보낸다', async () => {
    await send('T2', '01012345678', { password: 'pw' });

    expect(sent().content.at.title).toBe('비밀번호 안내');
  });

  it('제목의 변수도 치환한다', async () => {
    await send('T3', '01012345678', { toString: 'x', storeName: '강남점' });

    expect(sent().content.at.title).toBe('강남점 안내');
  });

  it('refKey 와 messageKey 를 돌려준다', async () => {
    const result = await send('T2', '01012345678', { password: 'pw' });

    expect(result).toEqual({ refKey: sent().refkey, messageKey: 'mk-1' });
    expect(result.refKey).toMatch(/^[0-9a-f]{20}$/);
  });

  it('변수 값 안의 #{...} 는 다시 치환하지 않는다', async () => {
    await send('T1', '01012345678', { name: '#{date}', date: 'x' });

    expect(sent().content.at.message).toBe(
      '#{date}님, x 근무가 변경되었습니다.',
    );
  });

  it('채우지 못한 변수가 있으면 보내지 않고 던진다', async () => {
    await expect(send('T1', '01012345678', { name: '홍길동' })).rejects.toThrow(
      'date',
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['null', { name: null as unknown as string, date: 'x' }, 'name'],
    ['상속받은 키', { storeName: 'x' }, 'toString'],
  ])(
    '변수 값이 문자열이 아니면(%s) 보내지 않고 던진다',
    async (_, variables, name) => {
      // ?? 로 원문을 남기면 #{name} 이 글자 그대로 나간다.
      const code = name === 'name' ? 'T1' : 'T3';
      await expect(send(code, '01012345678', variables)).rejects.toThrow(name);
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('없는 템플릿 코드는 보내지 않고 던진다', async () => {
    await expect(send('NOPE', '01012345678', {})).rejects.toThrow('NOPE');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['', '010-123', '0101234567890', '+82 10-1234-5678'])(
    '휴대폰 번호가 아니면(%s) 보내지 않고 던진다',
    async (to) => {
      const error = await send('T2', to, { password: 'pw' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      // 오류 메시지는 예외 필터 로그로 나갈 수 있어 번호를 가린다.
      if (to.length >= 8)
        expect((error as Error).message).not.toContain(to.replace(/\D/g, ''));
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('접수되면 번호를 가리고 본문은 남기지 않은 채 로그한다', async () => {
    await send('T2', '010-1234-5678', { password: 'pw-secret' });

    expect(logLog).toHaveBeenCalledTimes(1);
    const [line] = logLog.mock.calls[0] as [string];
    expect(line).toContain('T2');
    expect(line).toContain('mk-1');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('01012345678');
    expect(line).not.toContain('pw-secret');
  });

  it('비즈뿌리오 오류는 코드를 남기고 그대로 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);

    await expect(
      send('T2', '01012345678', { password: 'pw-secret' }),
    ).rejects.toBe(error);
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('code=2000');
    // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
    expect(line).toContain('bad');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('pw-secret');
  });
});
