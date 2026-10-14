import { PrismaService } from '../prisma/prisma.service';
import { MailPasswordResetLinkSender } from './mail-password-reset-link.sender';
import { NoopPasswordResetLinkSender } from './noop-password-reset-link.sender';
import { createPasswordResetLinkSender } from './password-reset-link-sender.provider';

describe('createPasswordResetLinkSender', () => {
  const prisma = {} as PrismaService;
  const config = (env: Record<string, string>) => ({
    get: (key: string) => env[key],
  });

  it('MAIL_* 가 있으면 메일로 보내는 발송기다', () => {
    const sender = createPasswordResetLinkSender(
      config({ MAIL_USERNAME: 'noreply@whale.test', MAIL_PASSWORD: 'pw' }),
      prisma,
    );
    expect(sender).toBeInstanceOf(MailPasswordResetLinkSender);
    expect(sender.isAvailable()).toBe(true);
  });

  it('MAIL_* 가 없으면 쓸 수 없는 발송기다 — 기동은 막지 않고 발급만 503', () => {
    const sender = createPasswordResetLinkSender(config({}), prisma);
    expect(sender).toBeInstanceOf(NoopPasswordResetLinkSender);
    expect(sender.isAvailable()).toBe(false);
  });

  it('MAIL_* 를 반만 넣었으면 기동 때 던진다', () => {
    expect(() =>
      createPasswordResetLinkSender(config({ MAIL_USERNAME: 'a@b.c' }), prisma),
    ).toThrow('MAIL_PASSWORD');
  });
});
