import type { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { createPlatformAdminMail } from './platform-admin-mail';

describe('createPlatformAdminMail', () => {
  const prisma = {} as PrismaService;
  const env =
    (values: Record<string, string | undefined>) =>
    (key: string): string | undefined =>
      values[key];
  const full = {
    MAIL_USERNAME: 'noreply@whale.test',
    MAIL_PASSWORD: 'app-password',
    ADMIN_WEB_URL: 'https://admin.whale.test/',
  };

  it('메일 설정과 관리자 웹 주소가 다 있으면 MailService 와 주소(끝 / 없이)를 준다', () => {
    const mail = createPlatformAdminMail({ get: env(full) }, prisma);

    expect(mail?.mail).toBeInstanceOf(MailService);
    expect(mail?.webUrl).toBe('https://admin.whale.test');
  });

  // main(PR #28): 메일 설정이 없는 환경에서도 api 는 떠야 한다. 이 메뉴는 메일만 보내지 않는다.
  it.each([
    ['메일 설정이 비면', { ...full, MAIL_USERNAME: '', MAIL_PASSWORD: ' ' }],
    ['관리자 웹 주소가 비면', { ...full, ADMIN_WEB_URL: undefined }],
    ['둘 다 비면', {}],
  ])('%s 기동은 하고 발송기는 없다(null)', (_, values) => {
    expect(createPlatformAdminMail({ get: env(values) }, prisma)).toBeNull();
  });

  it('메일 설정을 반만 넣으면 기동 때 던진다', () => {
    expect(() =>
      createPlatformAdminMail(
        { get: env({ ...full, MAIL_PASSWORD: undefined }) },
        prisma,
      ),
    ).toThrow(/MAIL_PASSWORD/);
  });

  it('관리자 웹 주소가 http(s) 가 아니면 기동 때 던진다', () => {
    expect(() =>
      createPlatformAdminMail(
        { get: env({ ...full, ADMIN_WEB_URL: 'admin.whale.test' }) },
        prisma,
      ),
    ).toThrow(/ADMIN_WEB_URL/);
  });
});
