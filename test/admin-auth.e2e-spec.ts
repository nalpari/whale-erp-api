import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginInfoResponseDto } from '../src/auth/dto/admin-login-info.response.dto';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Whale-admin-1';
const MIN = 60_000;

// 관리자 웹 로그인(1팀 admin_accounts)을 실제 DB 로 확인한다. 잠금이 행 잠금 아래에서 세어지는지,
// 로그아웃한 토큰이 남은 1시간과 상관없이 막히는지는 목으로 증명되지 않는다. 요청 제한 가드는 끈다.
describe('관리자 웹 로그인 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwordHash: string;
  let bpCodeId: number;
  let storeId: number;
  let roleGroupId: number;
  const adminIds: number[] = [];

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

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: '로그인 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '로그인 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    // BP 마스터 고정 권한(초기 데이터의 BM000001 과 그 메뉴 권한)을 쓴다.
    ({ roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    }));
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminLoginLog.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.temporaryPassword.deleteMany({ where: byAdmin });
    await prisma.adminStoreMapping.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  async function createAdmin(over: Record<string, unknown> = {}) {
    const admin = await prisma.adminAccount.create({
      data: {
        loginId: `adm${randomInt(10_000_000, 99_999_999)}`,
        bpCodeId,
        name: '홍길동',
        passwordHash,
        roleTypeCode: 'BM',
        roleGroupId,
        joinPathCode: 'SIGNUP',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
        ...over,
      },
    });
    adminIds.push(admin.adminAccountId);
    return admin;
  }

  const login = (loginId: string, password = PASSWORD) =>
    request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ loginId, password });
  const loginInfo = (token: string) =>
    request(app.getHttpServer())
      .get('/auth/admin/login-info')
      .set('Authorization', `Bearer ${token}`);
  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/auth/admin/refresh')
      .send({ refreshToken });

  it('로그인 → 로그인 정보 → 갱신 → 로그아웃', async () => {
    const admin = await createAdmin();

    const res = await login(admin.loginId);
    expect(res.status).toBe(200);
    const body = res.body as AdminLoginResponseDto;
    expect(body.account).toEqual({
      adminAccountId: admin.adminAccountId,
      loginId: admin.loginId,
      name: '홍길동',
      roleTypeCode: 'BM',
      bp: {
        bpCodeId,
        bpCode: expect.stringMatching(/^BP\d{6}$/) as unknown,
        tradeName: '로그인 테스트 BP',
        isPlatform: false,
      },
      isPasswordChangeRequired: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');

    const info = await loginInfo(body.accessToken);
    expect(info.status).toBe(200);
    const infoBody = info.body as AdminLoginInfoResponseDto;
    expect(infoBody.account.bp.bpCodeId).toBe(bpCodeId);
    expect(infoBody.menus.length).toBeGreaterThan(0);
    expect(infoBody.stores.map((s) => s.storeId)).toEqual([storeId]);
    expect(infoBody.codes.STORE_TYPE.map((c) => c.value)).toEqual([
      'DIRECT',
      'FRANCHISE',
    ]);

    const refreshed = await refresh(body.refreshToken);
    expect(refreshed.status).toBe(200);
    const newAccess = (refreshed.body as AdminRefreshResponseDto).accessToken;
    expect((await loginInfo(newAccess)).status).toBe(200);

    const out = await request(app.getHttpServer())
      .post('/auth/admin/logout')
      .set('Authorization', `Bearer ${newAccess}`);
    expect(out.status).toBe(204);
    // 남은 1시간과 상관없이 같은 세션의 토큰은 모두 막힌다.
    expect((await loginInfo(body.accessToken)).status).toBe(401);
    expect((await loginInfo(newAccess)).status).toBe(401);
    expect((await refresh(body.refreshToken)).status).toBe(401);
  });

  it('없는 아이디 · 틀린 비밀번호는 같은 401 문구다', async () => {
    const admin = await createAdmin();
    const wrong = await login(admin.loginId, 'nope');
    const missing = await login(`zz${randomInt(10_000_000, 99_999_999)}`);
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect((wrong.body as { message: string }).message).toBe(
      (missing.body as { message: string }).message,
    );
  });

  it('동시에 틀려도 다섯 번에서 잠기고, 잠기면 맞는 비밀번호도 429', async () => {
    const admin = await createAdmin();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => login(admin.loginId, 'nope')),
    );
    expect(results.every((r) => [401, 429].includes(r.status))).toBe(true);

    const stored = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(stored.failedLoginCount).toBe(5);
    expect(stored.lockExpiresAt).not.toBeNull();
    expect((await login(admin.loginId)).status).toBe(429);
  });

  it('미사용 계정은 맞는 비밀번호일 때만 403', async () => {
    const admin = await createAdmin({ accountStatusCode: 'INACTIVE' });
    expect((await login(admin.loginId)).status).toBe(403);
    expect((await login(admin.loginId, 'nope')).status).toBe(401);
  });

  it('임시 비밀번호로 들어오면 세션은 그 만료에서 끝나고 로그인 정보에 만료가 실린다', async () => {
    const admin = await createAdmin({
      passwordHash: '!',
      isPasswordChangeRequired: true,
    });
    const expiresAt = new Date(Date.now() + 20 * MIN);
    await prisma.temporaryPassword.create({
      data: {
        adminAccountId: admin.adminAccountId,
        passwordHash: await hashPassword('TempPass1234'),
        expiresAt,
        purpose: 'TEMPORARY',
      },
    });

    const res = await login(admin.loginId, 'TempPass1234');
    expect(res.status).toBe(200);
    const body = res.body as AdminLoginResponseDto;
    expect(new Date(body.refreshTokenExpiresAt).getTime()).toBe(
      expiresAt.getTime(),
    );
    expect(body.account.isPasswordChangeRequired).toBe(true);

    const info = (await loginInfo(body.accessToken))
      .body as AdminLoginInfoResponseDto;
    expect(
      new Date(info.account.temporaryPasswordExpiresAt as Date).getTime(),
    ).toBe(expiresAt.getTime());
    const refreshed = (await refresh(body.refreshToken))
      .body as AdminRefreshResponseDto;
    expect(new Date(refreshed.refreshTokenExpiresAt).getTime()).toBe(
      expiresAt.getTime(),
    );
  });

  it('직원 앱 토큰으로는 관리자 로그인 정보를 볼 수 없다', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/admin/login-info')
      .set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(401);
  });

  describe('공개 공통코드', () => {
    const codeItems = (bpCode: string, groups?: string) =>
      request(app.getHttpServer())
        .get(`/public-bp-codes/${bpCode}/code-items`)
        .query(groups === undefined ? {} : { groups });

    it('BP 코드 형식이 아니면 400, 없는 BP 는 404', async () => {
      expect((await codeItems('bp000000')).status).toBe(400);
      expect((await codeItems('BP99999')).status).toBe(400);
      const taken = await prisma.bpCode.findMany({ select: { bpCode: true } });
      let missing = 'BP999999';
      while (taken.some((b) => b.bpCode === missing))
        missing = `BP${randomInt(100_000, 999_999)}`;
      expect((await codeItems(missing)).status).toBe(404);
    });

    it('groups 로 고른 그룹만 받는다 — 없는 그룹은 빈 목록, 형식이 틀리면 400', async () => {
      const res = await codeItems(
        'BP000000',
        'STORE_TYPE, ACCOUNT_STATUS,NO_SUCH',
      );
      expect(res.status).toBe(200);
      const { codes } = res.body as AdminLoginInfoResponseDto;
      expect(Object.keys(codes).sort()).toEqual([
        'ACCOUNT_STATUS',
        'NO_SUCH',
        'STORE_TYPE',
      ]);
      expect(codes.STORE_TYPE.map((c) => c.value)).toEqual([
        'DIRECT',
        'FRANCHISE',
      ]);
      expect(codes.NO_SUCH).toEqual([]);

      expect((await codeItems('BP000000', 'store_type')).status).toBe(400);
      expect((await codeItems('BP000000', 'STORE_TYPE,')).status).toBe(400);
    });

    it('고객 BP 코드로도 로그인 없이 받는다', async () => {
      const { bpCode } = await prisma.bpCode.findUniqueOrThrow({
        where: { bpCodeId },
      });
      const res = await codeItems(bpCode);
      expect(res.status).toBe(200);
      expect(
        (res.body as AdminLoginInfoResponseDto).codes.STORE_TYPE.length,
      ).toBe(2);
    });

    it('로그인 없이 플랫폼 BP 의 공통코드 전체를 그룹별로 준다', async () => {
      const res = await codeItems('BP000000');
      expect(res.status).toBe(200);
      const { codes } = res.body as {
        codes: Record<
          string,
          { value: string; label: string; order: number }[]
        >;
      };
      expect(codes.ACCOUNT_STATUS).toEqual([
        { value: 'ACTIVE', label: '사용', order: 1 },
        { value: 'INACTIVE', label: '미사용', order: 2 },
        { value: 'WITHDRAWN', label: '탈퇴', order: 3 },
      ]);
      expect(codes.STORE_TYPE).toEqual([
        { value: 'DIRECT', label: '직영점포', order: 1 },
        { value: 'FRANCHISE', label: '가맹점포', order: 2 },
      ]);
      // 초기 데이터의 그룹(1팀 12 · 3팀 5).
      expect(Object.keys(codes)).toHaveLength(17);
    });
  });
});
