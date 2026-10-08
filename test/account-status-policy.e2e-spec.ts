import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccountStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { LoginResponseDto } from '../src/auth/dto/login.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// 계정 상태 정책(WHALEERP-168)을 실제 DB 로 확인한다. 정책은 "막지 않는다"와 "대신 들어가지
// 못한다"라서, 막을 만한 상황(퇴직, 오래 안 씀)을 실제로 만들어 놓고 여전히 통과하는지 본다.
describe('계정 상태 정책 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  const createdAccountIds: number[] = [];
  const createdStoreIds: number[] = [];
  // 계정이 없는 시도(없는 이메일·탈퇴한 계정)의 이력은 accountId 가 비어 계정으로는 못 찾는다.
  const attemptedEmails: string[] = [];
  let passwordHash: string;
  let storeId: number;

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
    jwt = app.get(JwtService);
    passwordHash = await hashPassword(PASSWORD);

    // 직원 레코드가 점포를 참조한다. 플랫폼 BP(마이그레이션이 넣어 둔다) 아래에 점포 하나를 만든다.
    const platform = await prisma.bpCode.findFirstOrThrow({
      where: { isPlatform: true },
    });
    const store = await prisma.store.create({
      data: {
        storeCode: `ST${String(randomInt(0, 1_000_000)).padStart(6, '0')}`,
        bpCodeId: platform.bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '정책 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    });
    storeId = store.storeId;
    createdStoreIds.push(storeId);
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다. 외래키가 RESTRICT 라 자식부터 지운다.
    const byAccount = { accountId: { in: createdAccountIds } };
    await prisma.staffMember.deleteMany({ where: byAccount });
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({
      where: { OR: [byAccount, { email: { in: attemptedEmails } }] },
    });
    await prisma.account.deleteMany({ where: byAccount });
    await prisma.store.deleteMany({
      where: { storeId: { in: createdStoreIds } },
    });
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

  const addStaffMember = (
    accountId: number,
    employmentStatus: 'EMPLOYED' | 'RETIRED',
  ) =>
    prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '홍길동',
        phone: '01012345678',
        employmentType: 'FULL_TIME',
        jobTitle: '매니저',
        employmentStatus,
        joinStatus: 'JOINED',
        ...(employmentStatus === 'RETIRED'
          ? { retiredDate: new Date('2026-09-30') }
          : {}),
      },
    });

  const login = (email: string, extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/auth/account/login')
      .send({ email, password: PASSWORD, ...extra });

  const logout = (accessToken: string) =>
    request(app.getHttpServer())
      .post('/auth/account/logout')
      .set('Authorization', `Bearer ${accessToken}`);

  describe('ACC-15 — 직원 계정은 퇴직해도 막지 않는다', () => {
    it('퇴직한 직원의 계정도 로그인된다', async () => {
      const account = await createAccount();
      await addStaffMember(account.accountId, 'RETIRED');

      const res = await login(account.email);

      expect(res.status).toBe(200);
      expect((res.body as LoginResponseDto).accessToken).toBeTruthy();
    });

    it('로그인한 뒤 퇴직 처리돼도 이미 받은 접속은 이어진다', async () => {
      const account = await createAccount();
      const staffMember = await addStaffMember(account.accountId, 'EMPLOYED');
      const body = (await login(account.email)).body as LoginResponseDto;

      await prisma.staffMember.update({
        where: { staffMemberId: staffMember.staffMemberId },
        data: {
          employmentStatus: 'RETIRED',
          retiredDate: new Date('2026-10-01'),
        },
      });

      // 갱신도, 액세스 토큰으로 호출하는 API 도 계속 통한다.
      const refreshed = await request(app.getHttpServer())
        .post('/auth/account/refresh')
        .send({ refreshToken: body.refreshToken });
      expect(refreshed.status).toBe(200);
      expect((await logout(body.accessToken)).status).toBe(204);
    });

    it('직원 레코드가 여럿이고 모두 퇴직이어도 로그인된다', async () => {
      const account = await createAccount();
      await addStaffMember(account.accountId, 'RETIRED');
      await addStaffMember(account.accountId, 'RETIRED');

      const res = await login(account.email);

      expect(res.status).toBe(200);
    });

    // 퇴직한 직원도 급여 탭에서 급여명세서를 보존 기간 동안 조회한다(PAY-4). 로그인이
    // 막히면 이 길이 끊기므로 위 세 건이 그 전제다. 조회 API 가 생기면 직접 확인한다.
    it.todo(
      '퇴직한 직원도 급여명세서를 조회할 수 있다 — [API] 급여명세서 목록·상세 조회(WHALEERP-330) 구현 때 추가',
    );
  });

  describe('ACC-15 — 탈퇴하지 않는 한 로그인된다', () => {
    const messageOf = (res: { body: unknown }) =>
      (res.body as { message: string }).message;

    it('탈퇴한 계정은 비밀번호가 맞아도 로그인되지 않는다', async () => {
      const account = await createAccount('WITHDRAWN');

      const res = await login(account.email);

      expect(res.status).toBe(401);
      expect(
        await prisma.authSession.count({
          where: { accountId: account.accountId },
        }),
      ).toBe(0);
    });

    it('없는 이메일과 같은 메시지로 답하고, 이력에는 계정 없이 없는 계정으로 남는다', async () => {
      const withdrawn = await createAccount('WITHDRAWN');
      const unknownEmail = `${randomUUID()}@test.invalid`;
      attemptedEmails.push(unknownEmail);

      const withdrawnRes = await login(withdrawn.email);
      const unknownRes = await login(unknownEmail);

      expect(messageOf(withdrawnRes)).toBe(messageOf(unknownRes));
      const [history] = await prisma.loginHistory.findMany({
        where: { email: withdrawn.email },
      });
      expect(history).toMatchObject({
        accountId: null,
        isSucceeded: false,
        failureReason: 'ACCOUNT_NOT_FOUND',
      });
    });

    it('연결이 보류된 계정은 탈퇴가 아니므로 로그인된다', async () => {
      const account = await createAccount('LINK_HOLD');

      const res = await login(account.email);

      expect(res.status).toBe(200);
    });
  });

  describe('ACC-18 — 휴면 계정을 두지 않는다', () => {
    it('마지막 로그인이 2년 전이고 접속이 오래전에 만료된 계정도 그대로 로그인된다', async () => {
      const account = await createAccount();
      const twoYearsAgo = new Date(Date.now() - 2 * YEAR_MS);
      await prisma.loginHistory.create({
        data: {
          accountId: account.accountId,
          email: account.email,
          isSucceeded: true,
          attemptedAt: twoYearsAgo,
        },
      });
      await prisma.authSession.create({
        data: {
          accountId: account.accountId,
          refreshTokenHash: randomUUID(),
          issuedAt: twoYearsAgo,
          lastUsedAt: twoYearsAgo,
          expiresAt: new Date(twoYearsAgo.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const res = await login(account.email);

      expect(res.status).toBe(200);
    });
  });

  describe('관리자는 직원의 비밀번호를 알 수 없고 대신 로그인하지 못한다', () => {
    it('관리자 토큰으로는 직원 계정 경로를 쓸 수 없다', async () => {
      const adminToken = await jwt.signAsync(
        { sub: 1, type: 'admin', email: 'admin@test.invalid', typ: 'access' },
        { expiresIn: '5m' },
      );

      const res = await logout(adminToken);

      expect(res.status).toBe(403);
    });

    it('로그인과 갱신 응답 어디에도 비밀번호 해시가 없다', async () => {
      const account = await createAccount();

      const res = await login(account.email);
      const body = res.body as LoginResponseDto;
      const refreshed = await request(app.getHttpServer())
        .post('/auth/account/refresh')
        .send({ refreshToken: body.refreshToken });

      for (const text of [
        JSON.stringify(res.body),
        JSON.stringify(refreshed.body),
      ]) {
        expect(text).not.toContain(account.passwordHash);
        expect(text).not.toContain('scrypt$');
        expect(text.toLowerCase()).not.toContain('passwordhash');
      }
    });

    it('직원 계정 경로는 정해진 것뿐이다 — 대신 로그인하거나 비밀번호를 보는 경로가 없다', () => {
      // 이 목록에 경로가 늘면 이 테스트가 깨진다. 늘리려는 경로가 관리자의 대리 로그인이나
      // 비밀번호 열람이 아닌지 정책(WHALEERP-168)을 먼저 확인한다.
      //
      // 2026-10-08 비밀번호 재설정 세 경로(WHALEERP-169 · 171)를 확인하고 더했다. 핀은 그 계정의
      // 메일함으로만 가고, 핀 요청은 계정이 있든 없든 같은 204 이며, 핀 확인은 맞는지만 알려 주고,
      // 변경은 그 핀이 있어야만 된다. 어느 것도 다른 사람의 비밀번호·토큰을 돌려주지 않는다.
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const accountPaths = Object.keys(document.paths)
        .filter((path) => path.startsWith('/auth/account'))
        .sort();

      expect(accountPaths).toEqual([
        '/auth/account/login',
        '/auth/account/logout',
        '/auth/account/password-reset',
        '/auth/account/password-reset-pins',
        '/auth/account/password-reset-pins/verify',
        '/auth/account/refresh',
      ]);
    });

    it('로그인에 다른 사람으로 들어가겠다는 입력을 실을 수 없다', async () => {
      const account = await createAccount();

      for (const extra of [
        { loginAs: account.accountId },
        { accountId: account.accountId },
        { adminId: 1 },
      ]) {
        const res = await login(account.email, extra);
        expect(res.status).toBe(400);
      }
    });
  });
});
