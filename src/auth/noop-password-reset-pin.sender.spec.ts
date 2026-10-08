import { Logger } from '@nestjs/common';
import { NoopPasswordResetPinSender } from './noop-password-reset-pin.sender';
import { PasswordResetPinSender } from './password-reset-pin-sender';

describe('NoopPasswordResetPinSender', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  const run = (appEnv: string | undefined, nodeEnv?: string) => {
    if (appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = appEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    return new NoopPasswordResetPinSender().isAvailable();
  };

  it('운영이 아니면 쓸 수 있다 — 개발 중에는 핀이 안 나가도 흐름을 끝까지 돌려 본다', () => {
    expect(run('local')).toBe(true);
    expect(run('dev')).toBe(true);
  });

  it('운영에서는 쓸 수 없다 — 핀을 보내지 못하면서 "보냈다"고 답하지 않게', () => {
    expect(run('prod')).toBe(false);
    expect(run(undefined, 'production')).toBe(false);
  });

  describe('기동할 때', () => {
    const boot = (appEnv: string) => {
      process.env.APP_ENV = appEnv;
      delete process.env.NODE_ENV;
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      new NoopPasswordResetPinSender().onModuleInit();
      return error;
    };

    it('운영이면 한 번 크게 남긴다 — 발송기 연결이 빠진 배포를 사용자 문의보다 먼저 알 수 있게', () => {
      expect(boot('prod')).toHaveBeenCalledTimes(1);
    });

    it('운영이 아니면 남기지 않는다', () => {
      expect(boot('dev')).not.toHaveBeenCalled();
    });
  });

  it('핀을 로그에 남기지 않는다', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    // 서비스가 부르는 모양(인자 셋) 그대로 부른다.
    const sender: PasswordResetPinSender = new NoopPasswordResetPinSender();
    await sender.send(
      { accountId: 7, email: 'staff@example.com', realName: '홍길동' },
      'AB12CD',
      new Date(),
    );

    expect(JSON.stringify(warn.mock.calls)).not.toContain('AB12CD');
  });
});
