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
// 켜 두면 한 이메일에 10번 넘게 보내는 이 테스트가 잠금이 아니라 요청 제한의
// 429 를 받아 둘을 구분할 수 없다. 요청 제한은 throttle.spec 이 따로 다룬다.
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

  it('잠긴 동안은 맞는 비밀번호도 429 이고 접속 상태를 만들지 않는다', async () => {
    const account = await createAccount();
    await failTimes(account.email, MAX_FAILED_ATTEMPTS);

    const res = await login(account.email, PASSWORD);

    expect(res.status).toBe(429);
    expect((res.body as { message: string }).message).toContain(
      '비밀번호를 재설정',
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
  });
});
