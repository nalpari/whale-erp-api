import { Logger } from '@nestjs/common';
import { NoopPasswordResetLinkSender } from './noop-password-reset-link.sender';
import { PasswordResetLinkSender } from './password-reset-link-sender';

describe('NoopPasswordResetLinkSender', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  const withEnv = (appEnv: string) => {
    process.env.APP_ENV = appEnv;
    delete process.env.NODE_ENV;
    return new NoopPasswordResetLinkSender();
  };

  it.each(['local', 'dev', 'prod'])(
    '어느 환경(%s)에서도 쓸 수 없다 — 메일을 보내지 못하면서 보냈다고 답해 핀 · 링크를 닫지 않게',
    (appEnv) => {
      expect(withEnv(appEnv).isAvailable()).toBe(false);
    },
  );

  it('불리면 보낸 척하지 않고 던지며, 토큰 · 링크를 로그 · 오류에 남기지 않는다', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // 서비스처럼 발송기 자리(추상 타입)로 부른다.
    const sender: PasswordResetLinkSender = withEnv('local');
    const sent = sender.send(
      { accountId: 7, email: 'a@b.com', realName: '홍길동' },
      {
        storeName: '연남점',
        link: 'https://x/password-reset/link#token=SECRET',
        expiresAt: new Date(),
        requestedBy: 3,
      },
    );
    await expect(sent).rejects.toThrow();
    await expect(sent).rejects.not.toThrow('SECRET');
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('accountId=7');
    expect(logged).not.toContain('SECRET');
  });
});
