import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { hashPassword, verifyPassword } from '../src/auth/password';
import type { MyProfileResponseDto } from '../src/my-profile/dto/my-profile.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';

// 직원 앱 내 정보 편집을 실제 DB 로 확인한다 — 주소 저장과 이력(189), 비밀번호 변경과 다른 기기 접속 종료(192), 위치정보 ·
// 본사 제공 동의의 상태 전환과 DB CHECK · 부분 고유 인덱스(193). 관리자 토큰 403, 남의 계정에 쓰지 않음, 탈퇴 401.
describe('내 정보 편집 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const PASSWORD = 'OldPass123!';

  let bpCodeId: number;
  let bmId: number;
  let otherId: number;
  let withdrawnId: number;
  const accountIds: number[] = [];

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '내 정보 편집 BP',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `edit${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    const hash = await hashPassword(PASSWORD);
    otherId = await account('남', 'JOINED', hash);
    withdrawnId = await account('탈퇴', 'WITHDRAWN', hash);
  });

  async function account(
    name: string,
    status: 'JOINED' | 'WITHDRAWN',
    passwordHash: string,
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `edit-${n}@test.invalid`,
        passwordHash,
        realName: name,
        birthDate: new Date('1998-03-04'),
        phone: `010${n}`,
        zipCode: '06236',
        address: '서울 강남구 테헤란로 1',
        addressDetail: '3층',
        status,
      },
    });
    accountIds.push(accountId);
    return accountId;
  }

  afterAll(async () => {
    if (!prisma) return;
    const where = { accountId: { in: accountIds } };
    await prisma.accountChangeHistory.deleteMany({ where });
    await prisma.locationConsentHistory.deleteMany({
      where: { locationConsent: where },
    });
    await prisma.locationConsent.deleteMany({ where });
    await prisma.authSession.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const adminToken = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: bmId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: bmId,
            type: 'admin',
            loginId: `admin${bmId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  /** 기기 하나의 접속과 그 접속의 접근 토큰 */
  const login = async (accountId: number, device = 'a') => {
    const session = await app.get(AuthSessionService).issue({
      accountId,
      deviceIdentifier: `edit-e2e-${accountId}-${device}`,
    });
    const token = await app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
    return { token, sid: session.authSessionId };
  };
  const send = (
    method: 'post' | 'put' | 'get',
    path: string,
    token?: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const profile = async (token: string) =>
    (await send('get', '/me/profile', token).expect(200))
      .body as MyProfileResponseDto;

  const ADDRESS = {
    zipCode: '04524',
    address: '서울 중구 세종대로 110',
    addressDetail: '2층 201호',
  };
  const WRITES: [method: 'post' | 'put', path: string, body?: object][] = [
    ['put', '/me/profile/address', ADDRESS],
    [
      'post',
      '/me/profile/password-change',
      { currentPassword: PASSWORD, newPassword: 'NewPass456!' },
    ],
    ['post', '/me/location-consent'],
    ['post', '/me/location-consent/pause'],
    ['post', '/me/location-consent/resume'],
    ['post', '/me/location-consent/withdraw'],
    ['post', '/me/hq-sharing-consent'],
    ['post', '/me/hq-sharing-consent/withdraw'],
  ];

  it('토큰이 없으면 401, 관리자 토큰은 403 — 쓰는 경로 모두', async () => {
    const admin = await adminToken();
    for (const [method, path, body] of WRITES) {
      await send(method, path, undefined, body).expect(401);
      await send(method, path, admin, body).expect(403);
    }
  });

  it('탈퇴 계정은 401 — 쓰는 경로 모두', async () => {
    const { token } = await login(withdrawnId);
    for (const [method, path, body] of WRITES)
      await send(method, path, token, body).expect(401);
  });

  describe('주소 (WHALEERP-189)', () => {
    it('저장하면 내 정보에 보이고, 변경 전후 값이 본인 이력으로 남는다. 남의 계정은 그대로다', async () => {
      const id = await account('주소', 'JOINED', await hashPassword(PASSWORD));
      const { token } = await login(id);
      await send('put', '/me/profile/address', token, ADDRESS).expect(204);

      expect(await profile(token)).toMatchObject(ADDRESS);
      const history = await prisma.accountChangeHistory.findMany({
        where: { accountId: id, field: 'ADDRESS' },
      });
      expect(history).toEqual([
        expect.objectContaining({
          channel: 'SELF',
          beforeValue: '(06236) 서울 강남구 테헤란로 1 3층',
          afterValue: '(04524) 서울 중구 세종대로 110 2층 201호',
        }),
      ]);
      const other = await prisma.account.findUniqueOrThrow({
        where: { accountId: otherId },
      });
      expect(other.zipCode).toBe('06236');
    });

    it('같은 값을 다시 저장하면 이력이 늘지 않는다', async () => {
      const id = await account('같은값', 'JOINED', '!');
      const { token } = await login(id);
      await send('put', '/me/profile/address', token, ADDRESS).expect(204);
      await send('put', '/me/profile/address', token, ADDRESS).expect(204);
      expect(
        await prisma.accountChangeHistory.count({
          where: { accountId: id, field: 'ADDRESS' },
        }),
      ).toBe(1);
    });

    it('상세 주소를 빼고 보내면 상세 주소는 비워진다 — PUT 은 주소 세 칸을 통째로 바꾼다', async () => {
      const id = await account('상세없음', 'JOINED', '!');
      const { token } = await login(id);
      const { zipCode, address } = ADDRESS;
      await send('put', '/me/profile/address', token, {
        zipCode,
        address,
      }).expect(204);
      expect((await profile(token)).addressDetail).toBeNull();
    });

    it('형식이 틀리면 400 이고 바꾸지 않는다 — 우편번호 · 빈 주소 · 모르는 칸', async () => {
      const id = await account('형식', 'JOINED', '!');
      const { token } = await login(id);
      for (const body of [
        { ...ADDRESS, zipCode: '1234' },
        { ...ADDRESS, address: '  ' },
        { ...ADDRESS, accountId: otherId },
      ])
        await send('put', '/me/profile/address', token, body).expect(400);
      expect((await profile(token)).zipCode).toBe('06236');
    });
  });

  describe('비밀번호 (WHALEERP-192)', () => {
    it('지금 비밀번호가 틀리면 400 사유, 규칙 위반이면 400 사유 — 둘 다 바꾸지 않는다', async () => {
      const id = await account('틀림', 'JOINED', await hashPassword(PASSWORD));
      const { token } = await login(id);
      const wrong = await send('post', '/me/profile/password-change', token, {
        currentPassword: 'Wrong123!',
        newPassword: 'NewPass456!',
      }).expect(400);
      expect((wrong.body as { message: string }).message).toBe(
        '지금 비밀번호가 맞지 않습니다',
      );
      const weak = await send('post', '/me/profile/password-change', token, {
        currentPassword: PASSWORD,
        newPassword: 'abcdefgh',
      }).expect(400);
      expect((weak.body as { message: string }).message).toBe(
        '영문 대문자·소문자·숫자·특수문자 중 2가지 이상을 섞어야 합니다',
      );
      const row = await prisma.account.findUniqueOrThrow({
        where: { accountId: id },
      });
      expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(true);
    });

    it('바꾸면 해시로만 저장되고, 이 기기는 이어지고 다른 기기는 끊기며, 값 없는 이력과 passwordChangedAt 이 남는다', async () => {
      const id = await account('변경', 'JOINED', await hashPassword(PASSWORD));
      const here = await login(id, 'here');
      const there = await login(id, 'there');
      const before = (await profile(here.token)).passwordChangedAt;

      await send('post', '/me/profile/password-change', here.token, {
        currentPassword: PASSWORD,
        newPassword: 'NewPass456!',
      }).expect(204);

      const row = await prisma.account.findUniqueOrThrow({
        where: { accountId: id },
      });
      expect(row.passwordHash).not.toContain('NewPass456!');
      expect(await verifyPassword('NewPass456!', row.passwordHash)).toBe(true);
      await send('get', '/me/profile', there.token).expect(401);
      const after = await profile(here.token);
      expect(new Date(after.passwordChangedAt).getTime()).toBeGreaterThan(
        new Date(before).getTime(),
      );
      const history = await prisma.accountChangeHistory.findMany({
        where: { accountId: id, field: 'PASSWORD' },
      });
      expect(history).toEqual([
        expect.objectContaining({
          channel: 'SELF',
          beforeValue: null,
          afterValue: null,
        }),
      ]);
    });
  });

  describe('비밀번호 동시 변경 (WHALEERP-192)', () => {
    it('두 기기에서 동시에 바꾸면 하나만 바뀐다 — 이긴 기기만 남고 진 기기는 400, 이력은 한 건', async () => {
      const id = await account('동시', 'JOINED', await hashPassword(PASSWORD));
      const a = await login(id, 'a');
      const b = await login(id, 'b');
      const results = await Promise.all([
        send('post', '/me/profile/password-change', a.token, {
          currentPassword: PASSWORD,
          newPassword: 'DeviceA111!',
        }),
        send('post', '/me/profile/password-change', b.token, {
          currentPassword: PASSWORD,
          newPassword: 'DeviceB222!',
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
      const [winner, loser] = results[0].status === 204 ? [a, b] : [b, a];
      const winnerPassword = winner === a ? 'DeviceA111!' : 'DeviceB222!';

      const row = await prisma.account.findUniqueOrThrow({
        where: { accountId: id },
      });
      expect(await verifyPassword(winnerPassword, row.passwordHash)).toBe(true);
      await send('get', '/me/profile', winner.token).expect(200);
      await send('get', '/me/profile', loser.token).expect(401);
      expect(
        await prisma.accountChangeHistory.count({
          where: { accountId: id, field: 'PASSWORD' },
        }),
      ).toBe(1);
    });
  });

  describe('위치정보 동의 (ATT-23 · ATT-26)', () => {
    // 동의는 시트에 보인 약관 버전을 반드시 싣는다 — 시행 중인 LOCATION 은 v1.1(20261028…_team3_location_terms_v1_1)
    const IN_FORCE = { termsVersion: 'v1.1' };

    it('보인 약관 버전을 빼면 400, 보인 약관이 없었는데(null) 시행 중인 약관이 있으면 409 — 동의를 남기지 않는다 (WHALEERP-628)', async () => {
      const id = await account(
        '위치필수',
        'JOINED',
        await hashPassword(PASSWORD),
      );
      const { token } = await login(id);
      await send('post', '/me/location-consent', token).expect(400);
      await send('post', '/me/location-consent', token, {
        termsVersion: null,
      }).expect(409);
      expect(
        await prisma.locationConsent.count({ where: { accountId: id } }),
      ).toBe(0);
    });

    it('본문의 약관 버전(화면이 보여 준 것)이 시행 중인 것과 다르면 409 이고 동의를 남기지 않는다 (WHALEERP-628)', async () => {
      const id = await account(
        '위치버전',
        'JOINED',
        await hashPassword(PASSWORD),
      );
      const { token } = await login(id);
      const res = await send('post', '/me/location-consent', token, {
        termsVersion: 'v1.0',
      }).expect(409);
      expect((res.body as { message: string }).message).toContain(
        '그사이 위치정보 약관이 바뀌었습니다',
      );
      expect(
        await prisma.locationConsent.count({ where: { accountId: id } }),
      ).toBe(0);
      await send('post', '/me/location-consent', token, {
        termsVersion: 'v1.1',
      }).expect(204);
      expect((await profile(token)).locationConsent).toMatchObject({
        state: 'AGREED',
        consentVersion: 'v1.1',
      });
      for (const termsVersion of [7, ''])
        // 이미 동의한 뒤라도 본문 검증(400)이 먼저다
        await send('post', '/me/location-consent', token, {
          termsVersion,
        }).expect(400);
      await send('post', '/me/location-consent', token, {
        termsVersion: 'v1.1',
        version: 'x', // 모르는 칸(forbidNonWhitelisted)
      }).expect(400);
    });

    it('동의 → 잠시 멈춤 → 다시 켜기 → 철회 → 다시 동의, 상태가 맞지 않으면 409', async () => {
      const id = await account('위치', 'JOINED', await hashPassword(PASSWORD));
      const { token } = await login(id);
      const state = async () => (await profile(token)).locationConsent;

      await send('post', '/me/location-consent/pause', token).expect(409);
      await send('post', '/me/location-consent', token, IN_FORCE).expect(204);
      expect(await state()).toMatchObject({
        state: 'AGREED',
        consentVersion: 'v1.1', // 시행 중인 LOCATION 약관(20261028…_team3_location_terms_v1_1)
      });
      await send('post', '/me/location-consent', token, IN_FORCE).expect(409);

      await send('post', '/me/location-consent/pause', token).expect(204);
      expect((await state()).state).toBe('PAUSED');
      await send('post', '/me/location-consent/pause', token).expect(409);
      await send('post', '/me/location-consent/resume', token).expect(204);
      expect((await state()).state).toBe('AGREED');
      await send('post', '/me/location-consent/resume', token).expect(409);

      await send('post', '/me/location-consent/withdraw', token).expect(204);
      expect((await state()).state).toBe('WITHDRAWN');
      await send('post', '/me/location-consent/withdraw', token).expect(409);

      await send('post', '/me/location-consent', token, IN_FORCE).expect(204);
      expect((await state()).state).toBe('AGREED');
      expect(
        await prisma.locationConsent.count({ where: { accountId: id } }),
      ).toBe(2); // 철회한 행은 남고 새 행이 생긴다
      // 동의 이력 — 409 로 막힌 것은 남지 않고, 한 동작에 한 줄씩(ATT-26)
      expect(
        (
          await prisma.locationConsentHistory.findMany({
            where: { locationConsent: { accountId: id } },
            orderBy: [
              { occurredAt: 'asc' },
              { locationConsentHistoryId: 'asc' },
            ],
            select: { action: true },
          })
        ).map((h) => h.action),
      ).toEqual(['AGREE', 'PAUSE', 'RESUME', 'WITHDRAW', 'AGREE']);
    });

    it('다섯 번 동시에 눌러도 철회 안 한 행은 하나 — 하나는 204, 나머지는 409', async () => {
      const { token } = await login(otherId);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          send('post', '/me/location-consent', token, IN_FORCE),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        204, 409, 409, 409, 409,
      ]);
      expect(
        await prisma.locationConsent.count({
          where: { accountId: otherId, withdrawnAt: null },
        }),
      ).toBe(1);
    });
  });

  describe('본사 제공 동의 (ATT-30)', () => {
    it('동의 → 철회 → 다시 동의, DB CHECK 를 지킨다. 상태가 맞지 않으면 409', async () => {
      const id = await account('본사', 'JOINED', await hashPassword(PASSWORD));
      const { token } = await login(id);
      const hq = async () => (await profile(token)).hqSharingConsent;

      await send('post', '/me/hq-sharing-consent/withdraw', token).expect(409);
      await send('post', '/me/hq-sharing-consent', token).expect(204);
      expect(await hq()).toMatchObject({
        isConsented: true,
        consentVersion: HQ_SHARING_CONSENT_VERSION,
        withdrawnAt: null,
      });
      await send('post', '/me/hq-sharing-consent', token).expect(409);

      await send('post', '/me/hq-sharing-consent/withdraw', token).expect(204);
      const withdrawn = await hq();
      expect(withdrawn.isConsented).toBe(false);
      expect(withdrawn.consentVersion).toBe(HQ_SHARING_CONSENT_VERSION);
      expect(withdrawn.withdrawnAt).not.toBeNull();

      await send('post', '/me/hq-sharing-consent', token).expect(204);
      expect(await hq()).toMatchObject({
        isConsented: true,
        withdrawnAt: null,
      });
    });

    it('더는 받아 주지 않는 문구 버전에 동의했으면 다시 묻고, 다시 동의하면 지금 버전으로 덮는다', async () => {
      const id = await account(
        '옛버전',
        'JOINED',
        await hashPassword(PASSWORD),
      );
      await prisma.account.update({
        where: { accountId: id },
        data: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: 'v0.9',
          hqSharingAgreedAt: new Date('2026-10-01T00:00:00Z'),
        },
      });
      const { token } = await login(id);
      const hq = async () => (await profile(token)).hqSharingConsent;

      expect(await hq()).toMatchObject({
        isConsented: true,
        consentVersion: 'v0.9',
        needsReconsent: true,
      });
      await send('post', '/me/hq-sharing-consent', token).expect(204);
      expect(await hq()).toMatchObject({
        isConsented: true,
        consentVersion: HQ_SHARING_CONSENT_VERSION,
        needsReconsent: false,
      });
      await send('post', '/me/hq-sharing-consent', token).expect(409);
    });
  });
});
