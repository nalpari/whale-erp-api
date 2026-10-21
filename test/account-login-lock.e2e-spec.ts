import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ATTEMPT_LOCK_MS, MAX_FAILED_ATTEMPTS } from '../src/auth/attempt-lock';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';

// 로그인 실패 잠금(WHALEERP-163)을 실제 DB 로 확인한다. 요청 제한 가드는 끈다 —
// 켜 두면 한 이메일에 10번 넘게 보내는 이 테스트가 잠금에 닿기 전에 요청 제한의
// 429 에 막힌다. 요청 제한은 auth-throttle e2e 가 따로 다룬다.
describe('로그인 실패 잠금 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
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

  const login = (email: string, password: string) =>
    request(app.getHttpServer())
      .post('/auth/account/login')
      .send({ email, password });

  const stored = (accountId: number) =>
    prisma.account.findUniqueOrThrow({
      where: { accountId },
      select: { failedLoginCount: true, lockExpiresAt: true },
    });

  /** 지정한 횟수만큼 틀린 비밀번호로 시도한다. 순서대로 보낸다. */
  async function failTimes(email: string, times: number) {
    const statuses: number[] = [];
    for (let i = 0; i < times; i += 1)
      statuses.push((await login(email, 'wrong-password')).status);
    return statuses;
  }

  it('4번째 틀린 시도까지는 401 이고 잠기지 않는다', async () => {
    const account = await createAccount();

    const statuses = await failTimes(account.email, MAX_FAILED_ATTEMPTS - 1);

    expect(statuses).toEqual([401, 401, 401, 401]);
    expect(await stored(account.accountId)).toEqual({
      failedLoginCount: 4,
      lockExpiresAt: null,
    });
  });

  it('5번째 틀린 시도에 5분 동안 잠그고 429 로 답한다', async () => {
    const account = await createAccount();

    const statuses = await failTimes(account.email, MAX_FAILED_ATTEMPTS);

    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const row = await stored(account.accountId);
    expect(row.failedLoginCount).toBe(5);
    const remaining = row.lockExpiresAt!.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(ATTEMPT_LOCK_MS - 10_000);
    expect(remaining).toBeLessThanOrEqual(ATTEMPT_LOCK_MS);
  });

  it('잠그게 된 429 에 저장된 해제 시각을 ISO 문자열로 싣는다', async () => {
    const account = await createAccount();
    await failTimes(account.email, MAX_FAILED_ATTEMPTS - 1);

    const res = await login(account.email, 'wrong-password');

    expect(res.status).toBe(429);
    const row = await stored(account.accountId);
    expect(res.body).toEqual({
      statusCode: 429,
      message: expect.stringMatching(/^로그인이 잠겼습니다/) as unknown,
      error: 'Too Many Requests',
      lockExpiresAt: row.lockExpiresAt!.toISOString(),
    });
  });

  it('잠긴 동안은 맞는 비밀번호도 429 이고 접속 상태를 만들지 않는다', async () => {
    const account = await createAccount();
    await failTimes(account.email, MAX_FAILED_ATTEMPTS);
    const lockedAt = await stored(account.accountId);

    const res = await login(account.email, PASSWORD);

    expect(res.status).toBe(429);
    expect((res.body as { message: string }).message).toContain(
      '비밀번호를 재설정',
    );
    // 다시 시도해도 해제 시각은 처음 잠근 그 시각이다.
    expect((res.body as { lockExpiresAt: string }).lockExpiresAt).toBe(
      lockedAt.lockExpiresAt!.toISOString(),
    );
    expect(
      await prisma.authSession.count({
        where: { accountId: account.accountId },
      }),
    ).toBe(0);
    const locked = await prisma.loginHistory.count({
      where: { accountId: account.accountId, failureReason: 'LOCKED' },
    });
    expect(locked).toBe(1);
  });

  it('잠긴 동안 더 틀려도 횟수와 해제 시각이 늘지 않는다', async () => {
    const account = await createAccount();
    await failTimes(account.email, MAX_FAILED_ATTEMPTS);
    const before = await stored(account.accountId);

    await failTimes(account.email, 3);

    expect(await stored(account.accountId)).toEqual(before);
  });

  it('해제 시각이 지나면 맞는 비밀번호로 로그인되고 횟수와 잠금이 지워진다', async () => {
    const account = await createAccount();
    await failTimes(account.email, MAX_FAILED_ATTEMPTS);
    await prisma.account.update({
      where: { accountId: account.accountId },
      data: { lockExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await login(account.email, PASSWORD);

    expect(res.status).toBe(200);
    expect(await stored(account.accountId)).toEqual({
      failedLoginCount: 0,
      lockExpiresAt: null,
    });
  });

  it('잠금이 풀린 뒤의 첫 실패는 1 부터 다시 센다', async () => {
    const account = await createAccount();
    await prisma.account.update({
      where: { accountId: account.accountId },
      data: { failedLoginCount: 5, lockExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await login(account.email, 'wrong-password');

    expect(res.status).toBe(401);
    expect(await stored(account.accountId)).toEqual({
      failedLoginCount: 1,
      lockExpiresAt: null,
    });
  });

  // 해제 시각을 주는 것이 가입 여부를 더 드러내지 않는다는 것 — 없는 이메일과 탈퇴 계정은 몇 번을 틀려도
  // 잠기지 않고, 가입된 계정의 틀린 시도와 같은 401 본문이다.
  it('없는 이메일과 탈퇴 계정은 몇 번을 틀려도 잠기지 않고 해제 시각 없는 401 이다', async () => {
    const withdrawn = await createAccount();
    await prisma.account.update({
      where: { accountId: withdrawn.accountId },
      data: { status: 'WITHDRAWN' },
    });
    const joined = await createAccount();
    const joinedFirst = await login(joined.email, 'wrong-password');

    for (const email of [`${randomUUID()}@test.invalid`, withdrawn.email]) {
      const responses: request.Response[] = [];
      for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i += 1)
        responses.push(await login(email, 'wrong-password'));

      expect(responses.map((r) => r.status)).toEqual(
        Array(MAX_FAILED_ATTEMPTS + 2).fill(401),
      );
      for (const res of responses) expect(res.body).toEqual(joinedFirst.body);
    }
  });

  it('로그인에 성공하면 쌓인 실패 횟수가 지워진다', async () => {
    const account = await createAccount();
    await failTimes(account.email, 3);

    const res = await login(account.email, PASSWORD);

    expect(res.status).toBe(200);
    expect((await stored(account.accountId)).failedLoginCount).toBe(0);
  });

  // 목으로는 증명할 수 없는 것. 행을 잠그지 않고 읽으면 동시에 들어온 틀린 시도가
  // 모두 같은 횟수를 읽고 같은 값을 써서 횟수가 덜 쌓이고, 병렬로 보내기만 해도
  // 5회 제한을 넘는다.
  it('틀린 시도를 동시에 여럿 보내도 정확히 5회에서 잠기고, 401 은 4번뿐이다', async () => {
    const account = await createAccount();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => login(account.email, 'wrong-password')),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(
      MAX_FAILED_ATTEMPTS - 1,
    );
    expect(statuses.filter((s) => s === 429)).toHaveLength(
      8 - (MAX_FAILED_ATTEMPTS - 1),
    );
    const row = await stored(account.accountId);
    expect(row.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.lockExpiresAt).not.toBeNull();
    // 늦게 온 요청도 시각을 새로 정하지 않고, 먼저 잠근 요청이 저장한 해제 시각 하나를 싣는다.
    const lockTimes = responses
      .filter((r) => r.status === 429)
      .map((r) => (r.body as { lockExpiresAt?: string }).lockExpiresAt);
    expect(new Set(lockTimes)).toEqual(
      new Set([row.lockExpiresAt!.toISOString()]),
    );
  });
});
