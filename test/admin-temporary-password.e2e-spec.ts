import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { MAIL_CONFIG } from '../src/mail/mail.config';
import { MAIL_TRANSPORT } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-1!';
const SAME =
  '입력한 정보와 일치하는 계정이 있으면 임시 비밀번호를 메일로 보냈습니다';

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
      .overrideProvider(MAIL_CONFIG)
      .useValue({ username: 'test@test.invalid', password: 'x' })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue({ sendMail })
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

  async function createAdmin() {
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
        failedLoginCount: 5,
        lockExpiresAt: new Date(Date.now() + 60_000), // 잠긴 계정
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
    expect(res.body).toEqual({ message: SAME });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [{ text: mailText }] = sendMail.mock.calls[0] as [{ text: string }];
    expect(mailText).toContain('http://localhost:3000/login');

    const after = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(after.lockExpiresAt).toBeNull();
    expect(after.isPasswordChangeRequired).toBe(true);
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

  it('일치하지 않으면 메일 없이 같은 응답', async () => {
    const admin = await createAdmin();
    const res = await request(app.getHttpServer())
      .post('/auth/admin/temporary-passwords')
      .send({ name: '다른사람', loginId: admin.loginId, email: admin.email })
      .expect(202);
    expect(res.body).toEqual({ message: SAME });
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

  it('메일이 실패하면 503 이고 임시 비밀번호를 남기지 않는다', async () => {
    const admin = await createAdmin();
    sendMail.mockRejectedValue(new Error('smtp down'));
    await issue(admin).expect(503);
    expect(
      await prisma.temporaryPassword.count({
        where: { adminAccountId: admin.adminAccountId },
      }),
    ).toBe(0);
  });
});
