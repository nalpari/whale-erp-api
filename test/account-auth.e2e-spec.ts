import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { hashPassword, hashToken } from '../src/auth/password';
import { LoginResponseDto } from '../src/auth/dto/login.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';

// supertest 의 res.body 는 any 라 응답 모양을 한곳에서 타입으로 준다.
const loginBody = (res: { body: unknown }) => res.body as LoginResponseDto;
const messageOf = (res: { body: unknown }) =>
  (res.body as { message: string }).message;

// 로그인 HTTP 계약을 실제 DB 로 확인한다. 요청 제한(IP 60/분, 계정 10/10분)에 걸리지
// 않도록 계정마다 다른 이메일을 쓰고 요청 수를 적게 유지한다.
describe('POST /auth/account/login (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  const createdAccountIds: number[] = [];
  const attemptedEmails: string[] = [];
  let passwordHash: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    // 비용이 큰 해시는 한 번만 만든다.
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다. 외래키가 RESTRICT 라 자식부터 지운다.
    const byAccount = { accountId: { in: createdAccountIds } };
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({
      where: { OR: [byAccount, { email: { in: attemptedEmails } }] },
    });
    await prisma.account.deleteMany({ where: byAccount });
    await app.close();
  });

  async function createAccount(status: AccountStatus = 'JOINED') {
    const email = `${randomUUID()}@test.invalid`;
    attemptedEmails.push(email);
    const account = await prisma.account.create({
      data: {
        email,
        passwordHash,
        realName: '홍길동',
        birthDate: new Date('1990-01-01'),
        phone: '01012345678',
        status,
      },
    });
    createdAccountIds.push(account.accountId);
    return account;
  }

  const login = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/auth/account/login').send(body);

  it('맞으면 200 과 토큰을 주고, 접속 상태와 성공 이력을 저장한다', async () => {
    const account = await createAccount();

    const res = await login({ email: account.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      account: {
        accountId: account.accountId,
        email: account.email,
        realName: '홍길동',
        status: 'JOINED',
      },
    });
    expect(loginBody(res).account).not.toHaveProperty('passwordHash');

    const sessions = await prisma.authSession.findMany({
      where: { accountId: account.accountId },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].refreshTokenHash).toBe(
      hashToken(loginBody(res).refreshToken),
    );
    expect(sessions[0].refreshTokenHash).not.toBe(loginBody(res).refreshToken);

    const history = await prisma.loginHistory.findMany({
      where: { accountId: account.accountId },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      isSucceeded: true,
      failureReason: null,
    });
  });

  it('액세스 토큰은 검증되고, 접속 상태 id(sid)를 싣는다', async () => {
    const account = await createAccount();

    const res = await login({ email: account.email, password: PASSWORD });

    const payload = await jwt.verifyAsync<Record<string, unknown>>(
      loginBody(res).accessToken,
    );
    const session = await prisma.authSession.findFirstOrThrow({
      where: { accountId: account.accountId },
    });
    expect(payload).toMatchObject({
      sub: account.accountId,
      type: 'account',
      typ: 'access',
      sid: session.authSessionId,
    });
  });

  it('이메일 대소문자와 앞뒤 공백은 가리지 않는다', async () => {
    const account = await createAccount();

    const res = await login({
      email: `  ${account.email.toUpperCase()} `,
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
  });

  it('가입 연결이 보류된 계정도 로그인되고 보류 상태가 내려온다', async () => {
    const account = await createAccount('LINK_HOLD');

    const res = await login({ email: account.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(loginBody(res).account.status).toBe('LINK_HOLD');
  });

  it('비밀번호가 틀리면 401 이고 접속 상태를 만들지 않는다', async () => {
    const account = await createAccount();

    const res = await login({ email: account.email, password: 'wrong' });

    expect(res.status).toBe(401);
    expect(
      await prisma.authSession.count({
        where: { accountId: account.accountId },
      }),
    ).toBe(0);
    const [history] = await prisma.loginHistory.findMany({
      where: { accountId: account.accountId },
    });
    expect(history).toMatchObject({
      isSucceeded: false,
      failureReason: 'PASSWORD_MISMATCH',
    });
  });

  it('없는 이메일도 같은 401 메시지이고, 이력에는 계정 없이 남는다', async () => {
    const account = await createAccount();
    const wrongPassword = await login({
      email: account.email,
      password: 'wrong',
    });
    const email = `${randomUUID()}@test.invalid`;
    attemptedEmails.push(email);

    const unknown = await login({ email, password: PASSWORD });

    expect(unknown.status).toBe(401);
    expect(messageOf(unknown)).toBe(messageOf(wrongPassword));
    const [history] = await prisma.loginHistory.findMany({ where: { email } });
    expect(history).toMatchObject({
      accountId: null,
      isSucceeded: false,
      failureReason: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('휴대전화번호는 로그인 아이디가 아니다 — 모르는 필드로 400 이다', async () => {
    const res = await login({ phone: '01012345678', password: PASSWORD });

    expect(res.status).toBe(400);
  });

  it('같은 기기로 다시 로그인하면 이전 접속만 종료된다', async () => {
    const account = await createAccount();
    const body = {
      email: account.email,
      password: PASSWORD,
      deviceIdentifier: 'iphone-1',
    };
    await login(body);
    await login({ ...body, deviceIdentifier: 'ipad-1' });

    await login(body);

    const rows = await prisma.authSession.findMany({
      where: { accountId: account.accountId },
    });
    const live = (device: string) =>
      rows.filter((r) => r.deviceIdentifier === device && !r.revokedAt).length;
    expect(live('iphone-1')).toBe(1);
    expect(live('ipad-1')).toBe(1);
    expect(rows).toHaveLength(3);
  });

  it('토큰 없이 닿는 공개 경로다', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/account/login')
      .send({});

    // 인증 거부(401)가 아니라 입력 검증(400)에서 걸려야 공개 경로다.
    expect(res.status).toBe(400);
  });
  describe('GET /auth/account/me', () => {
    const me = (accessToken?: string) => {
      const req = request(app.getHttpServer()).get('/auth/account/me');
      return accessToken
        ? req.set('Authorization', `Bearer ${accessToken}`)
        : req;
    };
    const loginAs = async (status: AccountStatus = 'JOINED') => {
      const account = await createAccount(status);
      const res = await login({ email: account.email, password: PASSWORD });
      return { account, tokens: loginBody(res) };
    };

    it('로그인 응답의 account 와 같은 모양으로 지금 계정 정보를 준다', async () => {
      const { account, tokens } = await loginAs();

      const res = await me(tokens.accessToken);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(tokens.account);
      expect(res.body).toEqual({
        accountId: account.accountId,
        email: account.email,
        realName: '홍길동',
        status: 'JOINED',
      });
    });

    it('로그인한 뒤 바뀐 상태와 이메일을 다시 로그인하지 않아도 보여 준다', async () => {
      const { account, tokens } = await loginAs('LINK_HOLD');
      const email = `${randomUUID()}@test.invalid`;
      await prisma.account.update({
        where: { accountId: account.accountId },
        data: { status: 'JOINED', email },
      });

      const res = await me(tokens.accessToken);

      expect(res.body).toMatchObject({ status: 'JOINED', email });
    });

    it('토큰이 없으면 401 이다', async () => {
      expect((await me()).status).toBe(401);
    });

    it('로그아웃한 접속의 토큰이면 401 이다', async () => {
      const { tokens } = await loginAs();
      await request(app.getHttpServer())
        .post('/auth/account/logout')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(204);

      expect((await me(tokens.accessToken)).status).toBe(401);
    });

    it('요청 제한을 받지 않는다 — 앱이 열릴 때마다 부르므로 로그인 경로의 토큰 한도(10분 10번)에 걸리면 안 된다', async () => {
      const { tokens } = await loginAs();

      const statuses: number[] = [];
      for (let i = 0; i < 12; i++)
        statuses.push((await me(tokens.accessToken)).status);

      expect(statuses).toEqual(Array<number>(12).fill(200));
    });
  });
});
