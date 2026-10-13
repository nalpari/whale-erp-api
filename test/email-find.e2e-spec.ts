import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccountStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { readJwtSecret } from '../src/auth/jwt-secret';
import { phoneKeyOf } from '../src/auth/phone-key';
import { PrismaService } from '../src/prisma/prisma.service';

const PATH = '/auth/account/email-find-attempts';

interface ErrorBody {
  message: string;
  lockExpiresAt?: string;
  emails?: unknown;
}
const errorOf = (res: request.Response) => res.body as ErrorBody;

// 이메일 찾기(WHALEERP-178)를 실제 DB 로 확인한다. 번호 기준 잠금은 시도 기록 표와 advisory lock 에 걸쳐 있어
// 목으로는 증명되지 않는다. 요청 제한 가드는 끈다 — 한 번호 · 한 IP 로 여러 번 보내는 이 테스트가 제한의
// 429 를 받는다(auth-throttle e2e 가 따로 다룬다).
describe('이메일 찾기 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let secret: string;
  const createdAccountIds: number[] = [];
  const usedPhones: string[] = [];

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
    secret = readJwtSecret(app.get(ConfigService).get<string>('JWT_SECRET'));
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다.
    await prisma.emailFindAttempt.deleteMany({
      where: { phoneKey: { in: usedPhones.map((p) => phoneKeyOf(secret, p)) } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: createdAccountIds } },
    });
    await app.close();
  });

  /** 다른 테스트 · 다른 사람의 행과 겹칠 가능성이 거의 없는 무작위 번호. */
  function newPhone() {
    const phone = `010${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    usedPhones.push(phone);
    return phone;
  }

  async function createAccount(
    phone: string,
    local: string,
    status: AccountStatus = 'JOINED',
  ) {
    const account = await prisma.account.create({
      data: {
        email: `${local}.${randomUUID().slice(0, 8)}@test.invalid`,
        passwordHash: '!',
        realName: '홍길동',
        birthDate: new Date('1990-05-17'),
        phone,
        status,
      },
    });
    createdAccountIds.push(account.accountId);
    return account;
  }

  const find = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(PATH).send(body);
  const body = (phone: string, over: Record<string, unknown> = {}) => ({
    name: '홍길동',
    phone,
    birthDate: '1990-05-17',
    ...over,
  });
  const attemptsOf = (phone: string) =>
    prisma.emailFindAttempt.findMany({
      where: { phoneKey: phoneKeyOf(secret, phone) },
      orderBy: { emailFindAttemptId: 'asc' },
    });

  it('맞으면 탈퇴 계정을 뺀 모든 계정의 이메일을 가려서 가입 순서대로 준다', async () => {
    const phone = newPhone();
    const first = await createAccount(phone, 'firstone');
    await createAccount(phone, 'gone', 'WITHDRAWN');
    const second = await createAccount(phone, 'second', 'LINK_HOLD');

    const res = await find(body(phone)).expect(200);

    const masked = (email: string) => {
      const [local, domain] = email.split('@');
      return `${local.slice(0, 2)}${'*'.repeat(local.length - 3)}${local.slice(-1)}@${domain}`;
    };
    expect(res.body).toEqual({
      emails: [masked(first.email), masked(second.email)],
    });
    // 이메일 원문은 응답 어디에도 없다.
    expect(JSON.stringify(res.body)).not.toContain(first.email);
  });

  it('휴대전화번호의 하이픈 · 공백은 받아 준다', async () => {
    const phone = newPhone();
    await createAccount(phone, 'hyphen');
    const dashed = `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
    await find(body(` ${dashed} `)).expect(200);
  });

  it('맞지 않으면 어느 값이 틀렸든 같은 404 이고, 시도 기록에는 번호 원문이 없다', async () => {
    const phone = newPhone();
    await createAccount(phone, 'wrong');

    const byName = await find(body(phone, { name: '김철수' })).expect(404);
    const byBirth = await find(body(phone, { birthDate: '1990-05-18' })).expect(
      404,
    );
    const byPhone = await find(body(newPhone())).expect(404);
    expect(errorOf(byName).message).toBe('일치하는 계정이 없습니다');
    expect(byBirth.body).toEqual(byName.body);
    expect(byPhone.body).toEqual(byName.body);

    const attempts = await attemptsOf(phone);
    expect(attempts.map((a) => [a.isSucceeded, a.failedCount])).toEqual([
      [false, 1],
      [false, 2],
    ]);
    expect(attempts[0].phoneKey).not.toContain(phone);
  });

  it('5번 틀리면 5분 막고, 막힌 동안은 맞는 값도 429 와 해제 시각을 받는다', async () => {
    const phone = newPhone();
    await createAccount(phone, 'locked');
    const wrong = body(phone, { name: '김철수' });

    for (let i = 0; i < 4; i++) await find(wrong).expect(404);
    const fifth = await find(wrong).expect(429);
    const lockExpiresAt = new Date(errorOf(fifth).lockExpiresAt!);
    expect(lockExpiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(lockExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      5 * 60_000,
    );

    const right = await find(body(phone)).expect(429);
    expect(errorOf(right).lockExpiresAt).toBe(errorOf(fifth).lockExpiresAt);
    expect(errorOf(right).emails).toBeUndefined();
  });

  it('성공하면 실패 횟수를 0으로 되돌린다', async () => {
    const phone = newPhone();
    await createAccount(phone, 'reset');
    for (let i = 0; i < 4; i++)
      await find(body(phone, { name: '김철수' })).expect(404);

    await find(body(phone)).expect(200);
    await find(body(phone, { name: '김철수' })).expect(404);

    const attempts = await attemptsOf(phone);
    expect(
      attempts.slice(-2).map((a) => [a.isSucceeded, a.failedCount]),
    ).toEqual([
      [true, 0],
      [false, 1],
    ]);
  });

  it('같은 번호로 동시에 보내도 5회 제한을 넘지 못한다', async () => {
    const phone = newPhone();
    await createAccount(phone, 'parallel');

    const statuses = (
      await Promise.all(
        Array.from({ length: 8 }, () => find(body(phone, { name: '김철수' }))),
      )
    ).map((r) => r.status);

    expect(statuses.filter((s) => s === 404)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    const attempts = await attemptsOf(phone);
    expect(Math.max(...attempts.map((a) => a.failedCount))).toBe(5);
  });

  it.each(['1990-02-30', '19900517', '1990-5-17'])(
    '생년월일 %s 은 400 이고 메시지는 한국어 한 줄이다 — 모양 오류와 없는 날짜가 같은 모양으로 나간다',
    async (birthDate) => {
      const res = await find(body(newPhone(), { birthDate })).expect(400);
      expect((res.body as { message: string[] }).message).toEqual([
        '생년월일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다',
      ]);
    },
  );

  it.each([
    ['생년월일이 날짜가 아니면', { birthDate: '1990-13-01' }],
    ['생년월일 모양이 다르면', { birthDate: '19900517' }],
    ['휴대전화번호 자리수가 틀리면', { phone: '010123' }],
    ['휴대전화번호에 문자가 섞이면', { phone: '010a2345678' }],
    ['이름이 비면', { name: '  ' }],
    ['모르는 칸이 있으면', { email: 'a@b.com' }],
  ])('%s 400 이고 시도로 세지 않는다', async (_, over) => {
    const phone = newPhone();
    await find(body(phone, over)).expect(400);
    expect(await attemptsOf(phone)).toHaveLength(0);
  });
});
