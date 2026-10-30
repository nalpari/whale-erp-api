import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '../src/auth/access-messages';
import { hashPassword } from '../src/auth/password';
import { ADMIN_MAIL } from '../src/auth/admin-temporary-password.service';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-1!';
const SENT = '등록된 이메일 주소로 임시 비밀번호가 발송되었습니다.';

// 비밀번호 찾기 → 임시 비밀번호 로그인까지 실제 DB 로 본다. 메일은 전송 계층만 바꿔 끼운다.
describe('POST /auth/admin/temporary-passwords (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sendMail = jest.fn();
  const created: number[] = [];
  let seed: { bpCodeId: number; roleGroupId: number };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      // 실제 MailService(템플릿 · 발송 이력)에 SMTP 만 바꿔 끼운다.
      .overrideProvider(ADMIN_MAIL)
      .useFactory({
        inject: [PrismaService],
        factory: (p: PrismaService) => ({
          mail: new MailService(
            { sendMail },
            { username: 'test@test.invalid' },
            p,
          ),
          webUrl: 'http://localhost:3000',
        }),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    seed = await prisma.adminAccount.findFirstOrThrow({
      where: { loginId: 'whaleadmin' },
      select: { bpCodeId: true, roleGroupId: true },
    });
  });

  beforeEach(() =>
    sendMail.mockReset().mockResolvedValue({ messageId: 'test' }),
  );

  afterAll(async () => {
    const mine = { adminAccountId: { in: created } };
    await prisma.adminSession.deleteMany({ where: mine });
    await prisma.adminLoginLog.deleteMany({ where: mine });
    await prisma.temporaryPassword.deleteMany({ where: mine });
    await prisma.mailSendLog.deleteMany({ where: mine });
    await prisma.adminAccount.deleteMany({ where: mine });
    await app.close();
  });

  async function createAdmin({ locked = true } = {}) {
    const loginId = `e2e${randomBytes(6).toString('hex')}`;
    const admin = await prisma.adminAccount.create({
      data: {
        loginId,
        bpCodeId: seed.bpCodeId,
        roleGroupId: seed.roleGroupId,
        name: '테스트',
        passwordHash: await hashPassword(PASSWORD),
        email: `${loginId}@test.invalid`,
        roleTypeCode: 'PM',
        joinPathCode: 'PLATFORM_REGISTERED',
        accountStatusCode: 'ACTIVE',
        ...(locked && {
          failedLoginCount: 5,
          lockExpiresAt: new Date(Date.now() + 60_000), // 잠긴 계정
        }),
      },
    });
    created.push(admin.adminAccountId);
    return admin;
  }

  const issue = (admin: { loginId: string; email: string | null }) =>
    request(app.getHttpServer())
      .post('/auth/admin/temporary-passwords')
      .send({ name: '테스트', loginId: admin.loginId, email: admin.email });
  const login = (loginId: string, password: string) =>
    request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ loginId, password });
  const sentPassword = () => {
    const [{ text }] = sendMail.mock.calls.at(-1) as [{ text: string }];
    return /임시 비밀번호: (\S{12})/.exec(text)![1];
  };

  it('일치하면 메일을 보내고 잠금을 풀며, 그 임시 비밀번호로 로그인하면 강제 변경 대상이다', async () => {
    const admin = await createAdmin();
    const res = await issue(admin).expect(202);
    expect(res.body).toEqual({ message: SENT });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [{ text: mailText }] = sendMail.mock.calls[0] as [{ text: string }];
    expect(mailText).toContain('http://localhost:3000/login');

    const after = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(after.lockExpiresAt).toBeNull();
    // 발급만으로는 강제 변경 대상이 아니다 — 아래 로그인 때 된다.
    expect(after.isPasswordChangeRequired).toBe(false);
    // 메일 이력에는 임시 비밀번호가 남지 않는다.
    const log = await prisma.mailSendLog.findFirstOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(log.body).not.toContain(sentPassword());

    const temp = await login(admin.loginId, sentPassword()).expect(200);
    const body = temp.body as AdminLoginResponseDto;
    expect(body.account.isPasswordChangeRequired).toBe(true);
    // 세션은 임시 비밀번호 만료(1시간)에서 끝난다.
    expect(
      new Date(body.refreshTokenExpiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(60 * 60_000);
    // 원래 비밀번호도 살아 있다.
    await login(admin.loginId, PASSWORD).expect(200);
  });

  it('잠금 해제는 계정 수정이 아니다 — updated_at 이 그대로다', async () => {
    const editedAt = new Date('2026-10-01T00:00:00.000Z');
    const admin = await createAdmin();
    await prisma.adminAccount.update({
      where: { adminAccountId: admin.adminAccountId },
      data: { updatedAt: editedAt },
    });
    await issue(admin).expect(202);

    const after = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(after.lockExpiresAt).toBeNull();
    expect(after.updatedAt).toEqual(editedAt);
  });

  it('로그인 중인 관리자는 누가 임시 비밀번호를 요청해도 계속 일한다', async () => {
    const admin = await createAdmin({ locked: false });
    const { accessToken } = (await login(admin.loginId, PASSWORD).expect(200))
      .body as AdminLoginResponseDto;
    // 이름 · 아이디 · 이메일만 아는 사람이 로그인 없이 부른다.
    await issue(admin).expect(202);
    await request(app.getHttpServer())
      .get('/auth/admin/login-info')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    // 업무 API 도 강제 변경 때문에 막히지 않는다(범위 때문에 403 일 수는 있다).
    const notifications = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${accessToken}`);
    expect((notifications.body as { message?: string }).message).not.toBe(
      PASSWORD_CHANGE_REQUIRED_MESSAGE,
    );
  });

  it('일치하지 않으면 메일 없이 아이디 찾기와 같은 문구의 404', async () => {
    const admin = await createAdmin();
    const res = await request(app.getHttpServer())
      .post('/auth/admin/temporary-passwords')
      .send({ name: '다른사람', loginId: admin.loginId, email: admin.email })
      .expect(404);
    expect((res.body as { message?: string }).message).toBe(
      '입력하신 정보와 일치하는 계정을 찾을 수 없습니다.',
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('다시 받으면 앞의 임시 비밀번호는 이미 써 본 것이라도 무효다', async () => {
    const admin = await createAdmin();
    await issue(admin).expect(202);
    const first = sentPassword();
    await login(admin.loginId, first).expect(200);
    await issue(admin).expect(202);
    await login(admin.loginId, first).expect(401);
    await login(admin.loginId, sentPassword()).expect(200);
  });

  it('메일이 실패하면 503 + 코드이고 임시 비밀번호를 남기지 않는다', async () => {
    const admin = await createAdmin();
    sendMail.mockRejectedValue(new Error('smtp down'));
    const res = await issue(admin).expect(503);
    expect((res.body as { code?: string }).code).toBe(
      'TEMPORARY_PASSWORD_SEND_FAILED',
    );
    expect(
      await prisma.temporaryPassword.count({
        where: { adminAccountId: admin.adminAccountId },
      }),
    ).toBe(0);
  });
});
