import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { LoginResponseDto } from '../src/auth/dto/login.response.dto';
import { RefreshResponseDto } from '../src/auth/dto/refresh.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';
const DAY_MS = 24 * 60 * 60 * 1000;

// 로그아웃·갱신·접속 만료(WHALEERP-164)를 실제 DB 로 확인한다. 가장 중요한 것은
// "액세스 토큰은 15분 유효하지만 접속이 종료되면 즉시 거부된다"는 점이다 — 서명만
// 보는 가드로는 목으로도 증명되지 않는다. 요청 제한 가드는 끈다(throttle.spec 이 따로 다룬다).
describe('로그아웃·갱신·접속 만료 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sessions: AuthSessionService;
  let jwt: JwtService;
  const createdAccountIds: number[] = [];
  let passwordHash: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    sessions = app.get(AuthSessionService);
    jwt = app.get(JwtService);
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다. 외래키가 RESTRICT 라 자식부터 지운다.
    const byAccount = { accountId: { in: createdAccountIds } };
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({ where: byAccount });
    await prisma.account.deleteMany({ where: byAccount });
    await app.close();
  });

  async function createAccount() {
    const account = await prisma.account.create({
      data: {
        email: `${randomUUID()}@test.invalid`,
        passwordHash,
        realName: '홍길동',
        birthDate: new Date('1990-01-01'),
        phone: '01012345678',
        status: 'JOINED',
      },
    });
    createdAccountIds.push(account.accountId);
    return account;
  }

  async function loginOn(email: string, deviceIdentifier?: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/account/login')
      .send({ email, password: PASSWORD, deviceIdentifier });
    expect(res.status).toBe(200);
    return res.body as LoginResponseDto;
  }

  const logout = (accessToken?: string) => {
    const req = request(app.getHttpServer()).post('/auth/account/logout');
    return accessToken
      ? req.set('Authorization', `Bearer ${accessToken}`)
      : req;
  };

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/auth/account/refresh')
      .send({ refreshToken });

  const messageOf = (res: { body: unknown }) =>
    (res.body as { message: string }).message;

  describe('로그아웃', () => {
    it('204 로 답하고 그 접속 상태를 종료한다', async () => {
      const account = await createAccount();
      const { accessToken } = await loginOn(account.email);

      const res = await logout(accessToken);

      expect(res.status).toBe(204);
      const [row] = await prisma.authSession.findMany({
        where: { accountId: account.accountId },
      });
      expect(row.revokedAt).not.toBeNull();
    });

    it('로그아웃 직후 아직 만료 전인 액세스 토큰도 거부된다', async () => {
      const account = await createAccount();
      const { accessToken } = await loginOn(account.email);
      // 서명상으로는 15분이 남은 토큰이다.
      const { exp } = jwt.decode<{ exp: number }>(accessToken);
      expect(exp * 1000 - Date.now()).toBeGreaterThan(10 * 60 * 1000);
      await logout(accessToken);

      const res = await logout(accessToken);

      expect(res.status).toBe(401);
    });

    it('로그아웃한 접속의 갱신 토큰으로는 다시 이어 갈 수 없다', async () => {
      const account = await createAccount();
      const { accessToken, refreshToken } = await loginOn(account.email);
      await logout(accessToken);

      const res = await refresh(refreshToken);

      expect(res.status).toBe(401);
    });

    it('그 기기만 종료하고 다른 기기는 그대로 둔다', async () => {
      const account = await createAccount();
      const phone = await loginOn(account.email, 'phone');
      const tablet = await loginOn(account.email, 'tablet');

      await logout(phone.accessToken);

      expect((await refresh(phone.refreshToken)).status).toBe(401);
      expect((await refresh(tablet.refreshToken)).status).toBe(200);
      // 다른 기기의 액세스 토큰도 여전히 통한다.
      expect((await logout(tablet.accessToken)).status).toBe(204);
    });

    it('토큰 없이는 닿을 수 없다 — 비로그인 상태에서는 아무것도 내려가지 않는다', async () => {
      const res = await logout();

      expect(res.status).toBe(401);
    });
  });

  describe('만료된 접속', () => {
    it('접속 상태가 만료되면 남은 유효시간이 있는 액세스 토큰도 즉시 거부된다', async () => {
      const account = await createAccount();
      const { accessToken, refreshToken } = await loginOn(account.email);
      await prisma.authSession.updateMany({
        where: { accountId: account.accountId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await logout(accessToken)).status).toBe(401);
      expect((await refresh(refreshToken)).status).toBe(401);
    });

    it('비밀번호 재설정처럼 모든 접속을 끊으면 모든 기기의 토큰이 거부된다', async () => {
      const account = await createAccount();
      const phone = await loginOn(account.email, 'phone');
      const tablet = await loginOn(account.email, 'tablet');

      await sessions.revokeAll(account.accountId);

      expect((await logout(phone.accessToken)).status).toBe(401);
      expect((await logout(tablet.accessToken)).status).toBe(401);
    });
  });

  describe('갱신', () => {
    it('새 액세스 토큰을 주고 갱신 토큰은 새로 주지 않는다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);

      const res = await refresh(login.refreshToken);

      expect(res.status).toBe(200);
      const body = res.body as RefreshResponseDto;
      expect(body.accessToken).toBeTruthy();
      expect(body.accessToken).not.toBe(login.accessToken);
      expect(res.body).not.toHaveProperty('refreshToken');
    });

    it('새 액세스 토큰은 같은 접속 상태의 것이고, 실제로 통한다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);
      const [session] = await prisma.authSession.findMany({
        where: { accountId: account.accountId },
      });

      const res = await refresh(login.refreshToken);

      const payload = jwt.decode<{ sid: number; typ: string }>(
        (res.body as RefreshResponseDto).accessToken,
      );
      expect(payload).toMatchObject({
        sid: session.authSessionId,
        typ: 'access',
      });
      expect(
        (await logout((res.body as RefreshResponseDto).accessToken)).status,
      ).toBe(204);
    });

    it('갱신할 때마다 만료가 지금부터 30일 뒤로 밀린다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);
      // 만료가 하루 남은 접속. 마지막 사용으로부터 29일이 지난 상태다.
      await prisma.authSession.updateMany({
        where: { accountId: account.accountId },
        data: { expiresAt: new Date(Date.now() + DAY_MS) },
      });

      await refresh(login.refreshToken);

      const [row] = await prisma.authSession.findMany({
        where: { accountId: account.accountId },
      });
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    });

    it('갱신 토큰을 회전하지 않는다 — 같은 토큰으로 계속 갱신된다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);

      const first = await refresh(login.refreshToken);
      const second = await refresh(login.refreshToken);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('모르는 토큰과 종료된 토큰은 같은 메시지의 401 이다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);
      await logout(login.accessToken);

      const revoked = await refresh(login.refreshToken);
      const unknown = await refresh('없는-토큰');

      expect(revoked.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(messageOf(revoked)).toBe(messageOf(unknown));
    });

    it('액세스 토큰을 갱신 토큰 자리에 보내도 갱신되지 않는다', async () => {
      const account = await createAccount();
      const login = await loginOn(account.email);

      const res = await refresh(login.accessToken);

      // JWT 는 갱신 토큰(43자)보다 훨씬 길어 길이 검증에서 400 으로 걸리고, 짧아졌더라도
      // 해시가 맞는 접속 상태가 없어 401 이다. 어느 쪽이든 새 토큰은 나가지 않는다.
      expect([400, 401]).toContain(res.status);
      expect(res.body).not.toHaveProperty('accessToken');
    });

    it('갱신 토큰이 비어 있으면 400 이다', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/account/refresh')
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
