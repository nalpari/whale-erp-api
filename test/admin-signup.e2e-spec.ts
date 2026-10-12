import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { SignupResponseDto } from '../src/admin-signup/dto/signup.response.dto';
import { verifyPassword } from '../src/auth/password';
import { MailService, type SendMailInput } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'whale-2026!';

/** Gmail 대신 보낸 메일을 모아 둔다. */
class CapturingMail {
  readonly sent: SendMailInput[] = [];
  send(input: SendMailInput) {
    this.sent.push(input);
    return Promise.resolve({ messageId: 'test' });
  }
}

// BP 회원가입을 실제 DB 로 확인한다. 고유 위반의 409 변환, BP 코드 채번 잠금, 약관 동의 기록은
// 목으로 증명되지 않는다. 요청 제한 가드는 끈다(throttle.spec 이 다룬다).
describe('BP 회원가입 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const mail = new CapturingMail();
  const loginIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(MailService)
      .useValue(mail)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다. 외래키가 RESTRICT 라 자식부터 지운다.
    const accounts = await prisma.adminAccount.findMany({
      where: { loginId: { in: loginIds } },
      select: { adminAccountId: true, bpCodeId: true },
    });
    const adminAccountId = { in: accounts.map((a) => a.adminAccountId) };
    await prisma.termsAgreementLog.deleteMany({ where: { adminAccountId } });
    await prisma.adminAccount.deleteMany({ where: { adminAccountId } });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: accounts.map((a) => a.bpCodeId) } },
    });
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const newLoginId = () => {
    const loginId = `e2e${randomBytes(6).toString('hex')}`;
    loginIds.push(loginId);
    return loginId;
  };
  const body = (overrides: Record<string, unknown> = {}) => {
    const loginId = newLoginId();
    return {
      loginId,
      password: PASSWORD,
      name: '정하윤',
      phone: '01048217730',
      email: `${loginId}@test.invalid`,
      tradeName: '㈜한강상회',
      agreeTermsOfUse: true,
      agreePrivacy: true,
      ...overrides,
    };
  };
  const signup = (payload: Record<string, unknown>) =>
    api().post('/auth/signup').send(payload);

  it('BP 와 BP 마스터 계정을 함께 만들고 가입 완료 토큰을 준다', async () => {
    const payload = body({ loginId: undefined });
    const loginId = newLoginId();
    payload.loginId = loginId.toUpperCase();
    payload.email = `${loginId.toUpperCase()}@Test.Invalid`;

    const res = await signup(payload).expect(201);
    const result = res.body as SignupResponseDto;
    expect(result).toEqual({
      signupToken: expect.any(String) as unknown,
      tradeName: '㈜한강상회',
      loginId,
      email: `${loginId}@test.invalid`,
    });

    const account = await prisma.adminAccount.findUniqueOrThrow({
      where: { loginId },
      include: { bpCode: true, roleGroup: true, termsAgreementLogs: true },
    });
    expect(account).toMatchObject({
      roleTypeCode: 'BM',
      joinPathCode: 'SIGNUP',
      accountStatusCode: 'ACTIVE',
      isAllStores: true,
      email: `${loginId}@test.invalid`,
      bpCode: {
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '㈜한강상회',
      },
      roleGroup: { roleCode: 'BM000001' },
    });
    expect(account.bpCode.bpCode).toMatch(/^BP[0-9]{6}$/);
    expect(account.bpCode.bpCode).not.toBe('BP000000');
    await expect(verifyPassword(PASSWORD, account.passwordHash)).resolves.toBe(
      true,
    );
    expect(account.termsAgreementLogs).toHaveLength(2);
    expect(
      account.termsAgreementLogs.every(
        (log) => log.channel === 'SIGNUP' && log.isAgreed,
      ),
    ).toBe(true);

    // 메일은 응답 뒤에 나간다.
    await new Promise((r) => setTimeout(r, 200));
    expect(
      mail.sent.filter((m) => m.adminAccountId === account.adminAccountId),
    ).toEqual([
      expect.objectContaining({
        templateCode: 'EMAIL_SIGNUP_DONE',
        to: `${loginId}@test.invalid`,
      }),
    ]);
  });

  it('가입 완료 토큰으로는 API 를 부를 수 없다', async () => {
    const res = await signup(body()).expect(201);
    const { signupToken } = res.body as SignupResponseDto;
    await api()
      .post('/auth/account/logout')
      .set('Authorization', `Bearer ${signupToken}`)
      .expect(401);
  });

  it('아이디는 대소문자를 가리지 않고 중복이다', async () => {
    const first = body();
    await signup(first).expect(201);
    const res = await signup(
      body({ loginId: String(first.loginId).toUpperCase() }),
    ).expect(409);
    expect((res.body as { message: string }).message).toBe(
      '사용할 수 없는 아이디입니다.',
    );
  });

  it('이메일이 쓰이고 있으면 409 다', async () => {
    const first = body();
    await signup(first).expect(201);
    const res = await signup(body({ email: first.email })).expect(409);
    expect((res.body as { message: string }).message).toBe(
      '이미 등록된 이메일입니다.',
    );
  });

  it('동시에 같은 아이디로 가입하면 하나만 된다', async () => {
    const first = body();
    const second = body({ loginId: first.loginId });
    const statuses = (await Promise.all([signup(first), signup(second)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([201, 409]);
  });

  it('동시에 가입한 BP 는 서로 다른 BP 코드를 받는다', async () => {
    const payloads = [body(), body(), body()];
    const responses = await Promise.all(payloads.map(signup));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    const accounts = await prisma.adminAccount.findMany({
      where: { loginId: { in: payloads.map((p) => String(p.loginId)) } },
      select: { bpCode: { select: { bpCode: true } } },
    });
    expect(new Set(accounts.map((a) => a.bpCode.bpCode)).size).toBe(3);
  });

  it('비밀번호 규칙에 맞지 않으면 400 이다', async () => {
    const res = await signup(body({ password: 'whale2026' })).expect(400);
    expect((res.body as { message: string }).message).toBe(
      '영문·숫자·특수문자를 모두 포함해 8~20자로 입력해 주세요.',
    );
  });

  it('필수 약관에 동의하지 않으면 400 이다', () =>
    signup(body({ agreePrivacy: false })).expect(400));

  it('모르는 칸이 오면 400 이다', () =>
    signup(body({ bizRegistrationNumber: '2118701234' })).expect(400));

  describe('중복 확인', () => {
    it('쓰는 아이디와 안 쓰는 아이디를 가른다', async () => {
      const first = body();
      await signup(first).expect(201);
      await api()
        .post('/auth/signup/login-id-availability')
        .send({ loginId: first.loginId })
        .expect(200, { available: false });
      await api()
        .post('/auth/signup/login-id-availability')
        .send({ loginId: newLoginId() })
        .expect(200, { available: true });
    });

    it('탈퇴한 계정의 이메일은 다시 쓸 수 있다', async () => {
      const first = body();
      await signup(first).expect(201);
      await api()
        .post('/auth/signup/email-availability')
        .send({ email: first.email })
        .expect(200, { available: false });
      await prisma.adminAccount.update({
        where: { loginId: String(first.loginId) },
        data: { accountStatusCode: 'WITHDRAWN' },
      });
      await api()
        .post('/auth/signup/email-availability')
        .send({ email: first.email })
        .expect(200, { available: true });
      await signup(body({ email: first.email })).expect(201);
    });

    it('형식이 틀리면 400 이다', () =>
      api()
        .post('/auth/signup/login-id-availability')
        .send({ loginId: '1234' })
        .expect(400));
  });
});
