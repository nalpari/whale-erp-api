import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 급여명세서 권한 점검(WHALEERP-242)을 실제 DB 로 고정한다 — 관리 범위(BP 마스터 · 가맹 마스터 · BP 관리자 · 가맹 관리자), 범위 밖
// 명세서는 같은 404, 본사 역할에게 동의 없는 가맹 점포 직원 명세서는 목록에서 가리고 상세 · 처리는 404(ATT-30), 직원은 자기에게
// 발송된 명세서만. 검토 대기 필터 · 건수(WHALEERP-234)의 가림도 함께 본다.
describe('급여명세서 권한 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const month = '2026-09';
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  let bpCodeId: number;
  let otherBpCodeId: number;
  const storeIds: Record<'direct' | 'direct2' | 'franchise' | 'other', number> =
    { direct: 0, direct2: 0, franchise: 0, other: 0 };
  const admins: Record<'bm' | 'ba' | 'fm' | 'fa', number> = {
    bm: 0,
    ba: 0,
    fm: 0,
    fa: 0,
  };
  const groupIds: number[] = [];
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  /** 명세서 — 직영(검토 대기) · 직영2(발송) · 가맹 동의 없음(검토 대기) · 가맹 동의 · 다른 BP */
  const slips: Record<
    'direct' | 'direct2' | 'hidden' | 'shared' | 'other',
    { payslipId: number; accountId: number }
  > = {} as never;

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
    const bp = async (offset: number) =>
      (
        await prisma.bpCode.create({
          data: {
            bpCode: `BP${(n + offset) % 1_000_000}`,
            isPlatform: false,
            accountStatusCode: 'ACTIVE',
            tradeName: '명세서 권한 BP',
          },
        })
      ).bpCodeId;
    bpCodeId = await bp(0);
    otherBpCodeId = await bp(1);
    const store = async (offset: number, owner: number, type: string) =>
      (
        await prisma.store.create({
          data: {
            storeCode: `ST${(n + offset) % 1_000_000}`,
            bpCodeId: owner,
            storeTypeCode: type,
            name: `명세서 권한 ${type} ${offset}`,
            storeStatusCode: 'OPERATING',
          },
        })
      ).storeId;
    storeIds.direct = await store(0, bpCodeId, 'DIRECT');
    storeIds.direct2 = await store(1, bpCodeId, 'DIRECT');
    storeIds.franchise = await store(2, bpCodeId, 'FRANCHISE');
    storeIds.other = await store(3, otherBpCodeId, 'DIRECT');

    const master = (roleCode: string) =>
      prisma.roleGroup.findFirstOrThrow({ where: { roleCode } });
    // BP 관리자 · 가맹 관리자 권한 그룹 — 급여명세서 메뉴(MN000009)를 모두 연다
    const group = async (
      roleTypeCode: 'BA' | 'FA',
      managerAdminAccountId?: number,
    ) => {
      const { roleGroupId } = await prisma.roleGroup.create({
        data: {
          roleCode: `${roleTypeCode}${n}`,
          bpCodeId,
          roleTypeCode,
          name: `명세서 권한 ${roleTypeCode} ${n}`,
          managerAdminAccountId,
          menus: {
            create: {
              menu: { connect: { menuCode: 'MN000009' } },
              isReadable: true,
              isCreatable: true,
              isUpdatable: true,
              isDeletable: true,
            },
          },
        },
      });
      groupIds.push(roleGroupId);
      return roleGroupId;
    };
    const admin = async (
      key: keyof typeof admins,
      roleTypeCode: string,
      roleGroupId: number,
      mapped: number[] | 'all',
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `payperm${key}${n}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: mapped === 'all',
          accountStatusCode: 'ACTIVE',
        },
      });
      if (mapped !== 'all')
        await prisma.adminStoreMapping.createMany({
          data: mapped.map((storeId) => ({ adminAccountId, storeId })),
        });
      admins[key] = adminAccountId;
    };
    await admin('bm', 'BM', (await master('BM000001')).roleGroupId, 'all');
    await admin('ba', 'BA', await group('BA'), [storeIds.direct]);
    await admin('fm', 'FM', (await master('FM000001')).roleGroupId, [
      storeIds.franchise,
    ]);
    await admin('fa', 'FA', await group('FA', admins.fm), [storeIds.franchise]);

    slips.direct = await payslip(storeIds.direct, '가직영', false, 'DRAFTING');
    slips.direct2 = await payslip(storeIds.direct2, '나직영', false, 'SENT');
    slips.hidden = await payslip(
      storeIds.franchise,
      '다가맹',
      false,
      'DRAFTING',
    );
    slips.shared = await payslip(
      storeIds.franchise,
      '라가맹동의',
      true,
      'DRAFTING',
    );
    slips.other = await payslip(storeIds.other, '마다른', false, 'DRAFTING');
    // 검토 대기 — 직영 · 동의 없는 가맹 직원 명세서에 확인 안 한 사유
    for (const s of [slips.direct, slips.hidden])
      await prisma.payslipReviewReason.create({
        data: {
          payslipId: s.payslipId,
          reviewReason: 'MISSING_ATTENDANCE',
          detail: '출퇴근 기록 1일 누락',
        },
      });
    // 검토 대기가 아닌 사유 — 확인한 사유(동의한 가맹 직원) · 발송된 명세서에 남은 사유는 배지 · 필터 · 건수 모두에서 빠진다
    await prisma.payslipReviewReason.create({
      data: {
        payslipId: slips.shared.payslipId,
        reviewReason: 'CONTRACT_CHANGED',
        acknowledgedAt: new Date(),
      },
    });
    await prisma.payslipReviewReason.create({
      data: {
        payslipId: slips.direct2.payslipId,
        reviewReason: 'AFTER_CONTRACT_END',
      },
    });
    // 발송된 명세서는 발송 이력이 있다
    await prisma.payslipDispatch.create({
      data: {
        payslipId: slips.direct2.payslipId,
        channel: 'EMAIL',
        status: 'SUCCEEDED',
        sentAt: new Date(),
      },
    });
  });

  async function payslip(
    storeId: number,
    name: string,
    consented: boolean,
    status: 'DRAFTING' | 'SENT',
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `payperm-${n}@test.invalid`,
        passwordHash: '!',
        realName: name,
        birthDate: new Date('1990-01-01'),
        phone: `010${n}`,
        status: 'JOINED',
        ...(consented
          ? {
              isHqSharingConsented: true,
              hqSharingConsentVersion: 'v1.0',
              hqSharingAgreedAt: new Date(),
            }
          : {}),
      },
    });
    accountIds.push(accountId);
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name,
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'JOINED',
      },
    });
    staffIds.push(staffMemberId);
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'PAPER',
        startDate: d('2026-08-01'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'SIGNED',
        createdBy: admins.bm,
      },
    });
    const { payslipId } = await prisma.payslip.create({
      data: {
        staffMemberId,
        storeId,
        contractId,
        periodStartDate: d('2026-09-01'),
        periodEndDate: d('2026-09-30'),
        employmentType: 'PART_TIME',
        attendanceStartDate: d('2026-09-01'),
        attendanceEndDate: d('2026-09-30'),
        status,
        grossPayAmount: 1_000_000,
        netPayAmount: 1_000_000,
        ...(status === 'SENT' && {
          confirmedAt: new Date(),
          confirmedBy: admins.bm,
        }),
      },
    });
    return { payslipId, accountId };
  }

  afterAll(async () => {
    if (!prisma) return;
    const owned = { payslip: { staffMemberId: { in: staffIds } } };
    await prisma.payslipDispatch.deleteMany({ where: owned });
    await prisma.payslipReviewReason.deleteMany({ where: owned });
    await prisma.payslipLog.deleteMany({ where: owned });
    await prisma.payslipItem.deleteMany({ where: owned });
    const records = { staffMemberId: { in: staffIds } };
    await prisma.payslip.deleteMany({ where: records });
    await prisma.contract.deleteMany({ where: records });
    await prisma.staffMember.deleteMany({ where: records });
    const accounts = { accountId: { in: accountIds } };
    await prisma.authSession.deleteMany({ where: accounts });
    await prisma.account.deleteMany({ where: accounts });
    const adminIds = Object.values(admins).filter((id) => id > 0);
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminStoreMapping.deleteMany({ where: byAdmin });
    // FA 그룹이 FM 계정을 관리계정으로 물고 있어 그룹을 먼저 지운다
    const groups = { roleGroupId: { in: groupIds } };
    await prisma.roleGroupMenu.deleteMany({ where: groups });
    await prisma.adminAccount.deleteMany({
      where: { ...byAdmin, roleGroupId: { in: groupIds } },
    });
    await prisma.roleGroup.deleteMany({ where: groups });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.store.deleteMany({
      where: { storeId: { in: Object.values(storeIds) } },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpCodeId] } },
    });
    await app.close();
  });

  // 가드가 관리자 세션을 확인하므로 실제 admin_sessions 행으로 토큰을 낸다
  const adminToken = async (sub: number) =>
    (
      await app.get(AdminSessionService).issue({ adminAccountId: sub }, (sid) =>
        app.get(JwtService).signAsync({
          sub,
          type: 'admin',
          loginId: `admin${sub}`,
          typ: 'access',
          sid,
        }),
      )
    ).accessToken;
  const staffToken = async (accountId: number) => {
    const session = await app.get(AuthSessionService).issue({
      accountId,
      deviceIdentifier: `payperm-e2e-${accountId}`,
    });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
  const call = async (
    who: keyof typeof admins,
    method: 'get' | 'post' | 'put',
    path: string,
    status: number,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await adminToken(admins[who])}`);
    // 상태 바꾸기(확정 · 다시 계산 · 발송)는 본문 updatedAt 이 있어야 한다 — 형식 오류(400)가 아니라 범위 판정까지 가게
    return (
      method === 'post'
        ? req.send({ updatedAt: new Date().toISOString() })
        : req
    ).expect(status);
  };

  type ListBody = {
    items: {
      payslipId: number | null;
      isMasked: boolean;
      storeId: number;
      staffName: string | null;
      pendingReviewReasons: string[] | null;
    }[];
    total: number;
    reviewPendingCount: number;
  };
  const list = async (who: keyof typeof admins, query = '') =>
    (await call(who, 'get', `/payslips?month=${month}${query}`, 200))
      .body as ListBody;

  it('BP 마스터 — BP 전체 점포의 명세서, 다른 BP 는 없다 · 동의 없는 가맹 직원 줄은 근무지 · 급여 기간만 남기고 가린다(ATT-30)', async () => {
    const { items } = await list('bm');
    expect(items.map((i) => i.storeId).sort()).toEqual(
      [
        storeIds.direct,
        storeIds.direct2,
        storeIds.franchise,
        storeIds.franchise,
      ].sort(),
    );
    const masked = items.filter((i) => i.isMasked);
    expect(masked).toEqual([
      expect.objectContaining({
        payslipId: null,
        staffName: null,
        storeId: storeIds.franchise,
        pendingReviewReasons: null,
      }),
    ]);
    expect(
      items.find((i) => i.payslipId === slips.shared.payslipId)?.isMasked,
    ).toBe(false);
  });

  it('BP 마스터 — 검토 대기만은 가린 줄을 빼고, 건수는 가린 줄도 센다(WHALEERP-234)', async () => {
    const all = await list('bm');
    expect(all.reviewPendingCount).toBe(2);
    expect(
      all.items.find((i) => i.payslipId === slips.direct.payslipId)
        ?.pendingReviewReasons,
    ).toEqual(['MISSING_ATTENDANCE']);
    for (const s of [slips.shared, slips.direct2])
      expect(
        all.items.find((i) => i.payslipId === s.payslipId)
          ?.pendingReviewReasons,
      ).toEqual([]);
    const pending = await list('bm', '&reviewPending=true');
    expect(pending.items.map((i) => i.payslipId)).toEqual([
      slips.direct.payslipId,
    ]);
    expect(pending.total).toBe(1);
    await call('bm', 'get', `/payslips?month=${month}&reviewPending=1`, 400);
  });

  it('BP 마스터 — 가린 명세서 · 다른 BP 명세서는 상세 · 처리 모두 같은 404, 동의한 가맹 직원 명세서는 연다', async () => {
    for (const s of [slips.hidden, slips.other]) {
      await call('bm', 'get', `/payslips/${s.payslipId}`, 404);
      await call('bm', 'get', `/payslips/${s.payslipId}/previous-values`, 404);
      await call('bm', 'post', `/payslips/${s.payslipId}/recalculate`, 404);
      await call('bm', 'post', `/payslips/${s.payslipId}/confirm`, 404);
      await call('bm', 'post', `/payslips/${s.payslipId}/send`, 404);
    }
    await call('bm', 'get', `/payslips/${slips.shared.payslipId}`, 200);
  });

  it('BP 관리자 — 매핑한 점포만, 그 밖의 명세서는 404', async () => {
    const { items } = await list('ba');
    expect(items.map((i) => i.payslipId)).toEqual([slips.direct.payslipId]);
    await call('ba', 'get', `/payslips/${slips.direct.payslipId}`, 200);
    for (const s of [slips.direct2, slips.shared, slips.other])
      await call('ba', 'get', `/payslips/${s.payslipId}`, 404);
    // 고른 점포가 범위 밖이면 조용히 빠진다
    expect((await list('ba', `&storeIds=${storeIds.direct2}`)).items).toEqual(
      [],
    );
  });

  it('가맹 마스터 — 자기 가맹점 명세서만, 본사 역할이 아니라 동의와 상관없이 보인다 · 메뉴 권한이 조회만이라 처리는 403', async () => {
    const { items } = await list('fm');
    expect(items.map((i) => i.payslipId).sort()).toEqual(
      [slips.hidden.payslipId, slips.shared.payslipId].sort(),
    );
    expect(items.every((i) => !i.isMasked)).toBe(true);
    await call('fm', 'get', `/payslips/${slips.hidden.payslipId}`, 200);
    await call('fm', 'get', `/payslips/${slips.direct.payslipId}`, 404);
    // FM000001 의 MN000009 는 조회만이다(초기 데이터 — 명세 Ⅱ-4). 확정 · 발송 · 다시 계산은 메뉴 권한에서 막힌다
    await call(
      'fm',
      'post',
      `/payslips/${slips.hidden.payslipId}/confirm`,
      403,
    );
  });

  it('가맹 관리자 — 매핑한 가맹점만, 범위 밖은 처리도 404', async () => {
    const { items } = await list('fa');
    expect(items.map((i) => i.payslipId).sort()).toEqual(
      [slips.hidden.payslipId, slips.shared.payslipId].sort(),
    );
    for (const s of [slips.direct, slips.other])
      await call('fa', 'post', `/payslips/${s.payslipId}/confirm`, 404);
  });

  it('직원 — 자기에게 발송된 명세서만, 남의 것 · 발송 전 것은 404 · 관리자 경로는 403', async () => {
    const mine = await staffToken(slips.direct2.accountId);
    const other = await staffToken(slips.direct.accountId);
    const get = (token: string, path: string, status: number) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(status);
    await get(mine, `/me/payslips/${slips.direct2.payslipId}`, 200);
    await get(other, `/me/payslips/${slips.direct2.payslipId}`, 404);
    // 자기 것이어도 발송 전(작성 중)이면 보이지 않는다
    await get(other, `/me/payslips/${slips.direct.payslipId}`, 404);
    await get(mine, `/payslips?month=${month}`, 403);
    await get(mine, `/payslips/${slips.direct2.payslipId}`, 403);
  });
});
