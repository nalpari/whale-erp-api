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

  it('운영이 아니면 쓸 수 있다 — 개발 중에는 메일이 안 나가도 흐름을 끝까지 돌려 본다', () => {
    expect(withEnv('local').isAvailable()).toBe(true);
  });

  it('운영에서는 쓸 수 없다 — 링크를 보내지 못하면서 보냈다고 답하지 않게', () => {
    expect(withEnv('prod').isAvailable()).toBe(false);
  });

  it('운영에서 이 발송기로 뜨면 기동 때 한 번 오류로 남긴다', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    withEnv('prod').onModuleInit();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('보낼 때 토큰 · 링크를 로그에 남기지 않는다 — 링크가 곧 비밀번호를 바꿀 권한이다', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // 서비스처럼 발송기 자리(추상 타입)로 부른다.
    const sender: PasswordResetLinkSender = withEnv('local');
    await sender.send(
      { accountId: 7, email: 'a@b.com', realName: '홍길동' },
      {
        storeName: '연남점',
        link: 'https://x/password-reset/link?token=SECRET',
        expiresAt: new Date(),
        requestedBy: 3,
      },
    );
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('accountId=7');
    expect(logged).not.toContain('SECRET');
  });
});
