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
import { STAFF_JOIN_STATES } from '../src/staff-members/join-state';
import {
  StaffMemberDetailResponseDto,
  StaffMemberListResponseDto,
} from '../src/staff-members/dto/staff-member-list.response.dto';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';

// 직원 목록(WHALEERP-329)을 실제 DB 로 확인한다. 가입 상태 필터는 초대 · 보류 관계 조건이라 목으로는 Prisma 가
// 그 조건을 맞게 푸는지 증명되지 않는다.
describe('직원 목록 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let consentStoreId: number; // 본사 제공 동의한 직원만 있는 가맹 점포
  let mixedStoreId: number; // 동의한 직원과 철회한 직원이 함께 있는 가맹 점포
  let otherBpId: number;
  let otherBpStoreId: number;
  let bmId: number; // BP 마스터, 전체 점포
  let baId: number; // BP 관리자, 전체 점포
  let fmId: number; // 가맹마스터, 가맹 점포 매핑
  let inactiveId: number; // 미사용 관리자
  let noReadId: number; // 직원 정보 관리 조회 권한이 없는 BP 관리자, 전체 점포
  let noReadRoleGroupId: number;
  let readOnlyId: number; // 직원 정보 관리 조회만 있는 BP 관리자, 전체 점포(수정 권한 없음)
  let readOnlyRoleGroupId: number;
  const adminIds: number[] = [];
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const n = randomInt(100_000, 999_999);
  const ids: Record<string, number> = {};

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

    const bp = (code: number, name: string) =>
      prisma.bpCode.create({
        data: {
          bpCode: `BP${code}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: name,
        },
      });
    const store = (
      code: number,
      bp: number,
      storeTypeCode: string,
      name: string,
    ) =>
      prisma.store.create({
        data: {
          storeCode: `ST${code}`,
          bpCodeId: bp,
          storeTypeCode,
          name,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ bpCodeId } = await bp(n, '목록 테스트 BP'));
    ({ bpCodeId: otherBpId } = await bp((n + 1) % 1_000_000, '다른 BP'));
    ({ storeId: directStoreId } = await store(n, bpCodeId, 'DIRECT', '직영점'));
    ({ storeId: franchiseStoreId } = await store(
      (n + 1) % 1_000_000,
      bpCodeId,
      'FRANCHISE',
      '가맹점',
    ));
    ({ storeId: consentStoreId } = await store(
      (n + 3) % 1_000_000,
      bpCodeId,
      'FRANCHISE',
      '동의 가맹점',
    ));
    ({ storeId: mixedStoreId } = await store(
      (n + 4) % 1_000_000,
      bpCodeId,
      'FRANCHISE',
      '혼합 가맹점',
    ));
    ({ storeId: otherBpStoreId } = await store(
      (n + 2) % 1_000_000,
      otherBpId,
      'DIRECT',
      '다른 BP 점포',
    ));

    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const admin = async (
      loginId: string,
      roleTypeCode: string,
      roleCode: string,
      extra: object,
    ) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId: await roleGroupId(roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: false,
          ...extra,
        },
      });
      adminIds.push(a.adminAccountId);
      return a.adminAccountId;
    };
    bmId = await admin(`listbm${n}`, 'BM', 'BM000001', { isAllStores: true });
    baId = await admin(`listba${n}`, 'BA', 'BM000001', { isAllStores: true });
    fmId = await admin(`listfm${n}`, 'FM', 'FM000001', {
      storeMappings: { create: { storeId: franchiseStoreId } },
    });
    inactiveId = await admin(`listoff${n}`, 'BM', 'BM000001', {
      isAllStores: true,
      accountStatusCode: 'INACTIVE',
    });
    // 조회만 끈다 — 수정 권한이 있어도 목록 · 상세는 조회 권한을 본다.
    const staffMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000005' },
    });
    ({ roleGroupId: noReadRoleGroupId } = await prisma.roleGroup.create({
      data: {
        // role_code CHECK 는 `^[A-Z]{2}[0-9]{6}$` 다.
        roleCode: `BA${String(n).padStart(6, '0')}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `목록 조회 없음 ${n}`,
        menus: {
          create: {
            menuId: staffMenu.menuId,
            isReadable: false,
            isUpdatable: true,
          },
        },
      },
    }));
    const noRead = await prisma.adminAccount.create({
      data: {
        loginId: `listnoread${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BA',
        roleGroupId: noReadRoleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        accountStatusCode: 'ACTIVE',
        isAllStores: true,
      },
    });
    noReadId = noRead.adminAccountId;
    adminIds.push(noReadId);
    ({ roleGroupId: readOnlyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${String((n + 1) % 1_000_000).padStart(6, '0')}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `목록 조회만 ${n}`,
        menus: {
          create: {
            menuId: staffMenu.menuId,
            isReadable: true,
            isUpdatable: false,
          },
        },
      },
    }));
    const readOnly = await prisma.adminAccount.create({
      data: {
        loginId: `listreadonly${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BA',
        roleGroupId: readOnlyRoleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        accountStatusCode: 'ACTIVE',
        isAllStores: true,
      },
    });
    readOnlyId = readOnly.adminAccountId;
    adminIds.push(readOnlyId);

    const staff = async (
      key: string,
      storeId: number,
      name: string,
      joinStatus: 'DRAFT' | 'INVITED' | 'JOINED',
      extra: object = {},
    ) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus,
          ...extra,
        },
      });
      staffIds.push(s.staffMemberId);
      ids[key] = s.staffMemberId;
      return s.staffMemberId;
    };
    // 본사 제공 동의는 계정에 있다(2026-10-20) — 동의 기록이 있는 직원은 그 값을 담은 계정에 묶는다
    const consentAccount = async (consent: object) => {
      const phone = `010${randomInt(10_000_000, 99_999_999)}`;
      const account = await prisma.account.create({
        data: {
          email: `list-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '동의계정',
          birthDate: new Date('1990-01-01'),
          phone,
          status: 'JOINED',
          ...consent,
        },
      });
      accountIds.push(account.accountId);
      return { accountId: account.accountId };
    };
    const invite = (
      staffMemberId: number,
      invitationType: 'SIGNUP' | 'REINVITE' | 'AFFILIATION_CONFIRM',
      status:
        'SENT' | 'EXPIRED' | 'ACCEPTED' | 'REJECTED' | 'REJECTED_UNDER_AGE',
      sentAt = new Date(),
    ) =>
      prisma.invitation.create({
        data: {
          staffMemberId,
          invitationType,
          // 가입 초대 · 재초대는 토큰이 있어야 한다(CHECK invitations_token_required), 토큰은 고유하다.
          invitationToken:
            invitationType === 'AFFILIATION_CONFIRM'
              ? null
              : `list-e2e-${n}-${randomInt(1_000_000_000)}`,
          channel: 'SMS',
          sentAt,
          expiresAt: new Date(sentAt.getTime() + 30 * 86_400_000),
          status,
        },
      });

    await staff('joined', directStoreId, '가입직원', 'JOINED');
    await staff('draft', directStoreId, '초안직원', 'DRAFT');
    await invite(
      await staff('invited', directStoreId, '초대직원', 'INVITED'),
      'SIGNUP',
      'SENT',
    );
    await invite(
      await staff('affiliation', directStoreId, '소속확인직원', 'INVITED'),
      'AFFILIATION_CONFIRM',
      'SENT',
    );
    await invite(
      await staff('underAge', directStoreId, '미성년직원', 'INVITED'),
      'SIGNUP',
      'REJECTED_UNDER_AGE',
    );
    const expiredId = await staff(
      'expired',
      directStoreId,
      '만료직원',
      'INVITED',
    );
    await invite(
      expiredId,
      'SIGNUP',
      'EXPIRED',
      new Date('2026-08-01T00:00:00Z'),
    );
    // 만료 뒤 재초대가 나간 직원은 INVITED 이고 EXPIRED 필터에 걸리지 않는다.
    const reinvitedId = await staff(
      'reinvited',
      directStoreId,
      '재초대직원',
      'INVITED',
    );
    await invite(
      reinvitedId,
      'SIGNUP',
      'EXPIRED',
      new Date('2026-08-01T00:00:00Z'),
    );
    await invite(reinvitedId, 'REINVITE', 'SENT');

    const heldId = await staff('held', directStoreId, '보류직원', 'INVITED');
    const heldInvitation = await invite(heldId, 'SIGNUP', 'ACCEPTED');
    const holdAccount = await prisma.account.create({
      data: {
        email: `hold-${n}@test.invalid`,
        passwordHash: '!',
        realName: '가입자실명',
        birthDate: new Date('1990-01-01'),
        phone: `0109999${String(n).slice(-4)}`,
        status: 'JOINED',
      },
    });
    accountIds.push(holdAccount.accountId);
    await prisma.linkHold.create({
      data: {
        invitationId: heldInvitation.invitationId,
        accountId: holdAccount.accountId,
        mismatchReason: 'PHONE_MISMATCH',
      },
    });

    // 수락했지만 가입 완료도 보류도 아닌 중간 상태 — 표시는 INVITED, 필터도 INVITED 여야 한다.
    await invite(
      await staff('accepted', directStoreId, '수락직원', 'INVITED'),
      'SIGNUP',
      'ACCEPTED',
    );
    const expiredAcceptedId = await staff(
      'expiredAccepted',
      directStoreId,
      '만료후수락직원',
      'INVITED',
    );
    await invite(
      expiredAcceptedId,
      'SIGNUP',
      'EXPIRED',
      new Date('2026-08-01T00:00:00Z'),
    );
    await invite(expiredAcceptedId, 'REINVITE', 'ACCEPTED');
    // 거절 뒤 만료 — 순서와 상관없이 REJECTED.
    const rejectedExpiredId = await staff(
      'rejectedExpired',
      directStoreId,
      '거절후만료직원',
      'INVITED',
    );
    await invite(
      rejectedExpiredId,
      'AFFILIATION_CONFIRM',
      'REJECTED',
      new Date('2026-08-01T00:00:00Z'),
    );
    await invite(rejectedExpiredId, 'SIGNUP', 'EXPIRED');

    // 만 19세 미만으로 막힌 뒤 다시 초대 — 새 초대가 이겨 INVITED.
    const underAgeReinvitedId = await staff(
      'underAgeReinvited',
      directStoreId,
      '미성년재초대직원',
      'INVITED',
    );
    await invite(
      underAgeReinvitedId,
      'SIGNUP',
      'REJECTED_UNDER_AGE',
      new Date('2026-08-01T00:00:00Z'),
    );
    await invite(underAgeReinvitedId, 'REINVITE', 'SENT');

    await staff('franchise', franchiseStoreId, '가맹직원', 'JOINED');
    await staff(
      'consented',
      consentStoreId,
      '동의직원',
      'JOINED',
      await consentAccount({
        isHqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        hqSharingAgreedAt: new Date(),
      }),
    );
    await staff(
      'mixedConsented',
      mixedStoreId,
      '혼합동의',
      'JOINED',
      await consentAccount({
        isHqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        hqSharingAgreedAt: new Date(),
      }),
    );
    // 철회한 계정은 버전 · 동의 시각을 남긴 채 칸만 false 다(CHECK accounts_hq_sharing_not_consented_fields).
    await staff(
      'mixedWithdrawn',
      mixedStoreId,
      '혼합철회',
      'JOINED',
      await consentAccount({
        isHqSharingConsented: false,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        hqSharingAgreedAt: new Date('2026-10-01T00:00:00Z'),
        hqSharingWithdrawnAt: new Date('2026-10-05T00:00:00Z'),
      }),
    );
    await staff('otherBp', otherBpStoreId, '다른BP직원', 'JOINED');
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.linkHold.deleteMany({ where: { invitation: byStaff } });
    await prisma.invitation.deleteMany({ where: byStaff });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminStoreMapping.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.roleGroupMenu.deleteMany({
      where: { roleGroupId: { in: [noReadRoleGroupId, readOnlyRoleGroupId] } },
    });
    await prisma.roleGroup.deleteMany({
      where: { roleGroupId: { in: [noReadRoleGroupId, readOnlyRoleGroupId] } },
    });
    await prisma.store.deleteMany({
      where: {
        storeId: {
          in: [
            directStoreId,
            franchiseStoreId,
            consentStoreId,
            mixedStoreId,
            otherBpStoreId,
          ],
        },
      },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
    await app.close();
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const tokenOf = async (sub: number) =>
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
  /** 응답 본문은 any 라 린트(no-unsafe-*)를 지나도록 응답 DTO 모양을 붙여 돌려준다. */
  const get = async (query: string, sub = bmId) => {
    const res = await request(app.getHttpServer())
      .get(`/staff-members${query}`)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return { status: res.status, body: res.body as StaffMemberListResponseDto };
  };
  const idsOf = (body: { items: { staffMemberId: number | null }[] }) =>
    body.items.map((i) => i.staffMemberId);
  // 가린 행은 ID 를 내지 않는다. 가맹 점포에는 ids.franchise 한 명뿐이라 점포로 찾는다.
  const franchiseRow = (body: StaffMemberListResponseDto) =>
    body.items.find((i) => i.store.storeId === franchiseStoreId);

  it('관리 범위의 직원만, 최근 등록 먼저 — 다른 BP 는 없다', async () => {
    const res = await get('?pageSize=200');
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).not.toContain(ids.otherBp);
    expect(idsOf(res.body)).toEqual(
      [...staffIds]
        .filter((id) => id !== ids.otherBp)
        .sort((a, b) => b - a)
        .map((id) =>
          id === ids.franchise || id === ids.mixedWithdrawn ? null : id,
        ),
    );
    expect(res.body.total).toBe(staffIds.length - 1);
  });

  it('BP 마스터에게 가맹 점포 직원은 가린 행이고 total 에 센다', async () => {
    const res = await get('?pageSize=200');
    const row = franchiseRow(res.body);
    expect(row).toMatchObject({
      staffMemberId: null,
      isMasked: true,
      name: null,
      phone: null,
    });
    expect(row?.store).toEqual({
      storeId: franchiseStoreId,
      name: '가맹점',
      storeType: 'FRANCHISE',
    });
  });

  it('본사 제공 동의한 가맹 점포 직원은 BP 마스터에게 가리지 않는다(ATT-30)', async () => {
    const res = await get(`?pageSize=200&storeIds=${consentStoreId}`);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        staffMemberId: ids.consented,
        isMasked: false,
        name: '동의직원',
      }),
    ]);
  });

  it('본사 제공 동의한 가맹 점포 직원은 BP 관리자가 검색으로 찾는다', async () => {
    const res = await get(`?keyword=${encodeURIComponent('동의직원')}`, baId);
    expect(idsOf(res.body)).toEqual([ids.consented]);
    expect(res.body.total).toBe(1);
  });

  it('더는 받아 주지 않는 문구 버전에 동의한 직원은 다시 동의할 때까지 가린다 — 검색에도 걸리지 않는다(WHALEERP-137)', async () => {
    const { accountId } = await prisma.staffMember.findUniqueOrThrow({
      where: { staffMemberId: ids.consented },
      select: { accountId: true },
    });
    const version = (hqSharingConsentVersion: string) =>
      prisma.account.update({
        where: { accountId: accountId! },
        data: { hqSharingConsentVersion },
      });
    await version('v0.9');
    try {
      const res = await get(`?pageSize=200&storeIds=${consentStoreId}`);
      expect(res.body.items).toEqual([
        expect.objectContaining({ staffMemberId: null, isMasked: true }),
      ]);
      const found = await get(
        `?keyword=${encodeURIComponent('동의직원')}`,
        baId,
      );
      expect(found.body.total).toBe(0);
    } finally {
      await version(HQ_SHARING_CONSENT_VERSION);
    }
  });

  it('폐점한 가맹 점포의 직원은 동의했어도 본사 역할에게 가린다 — 상세도 404(ATT-30 v227)', async () => {
    const status = (storeStatusCode: string) =>
      prisma.store.update({
        where: { storeId: consentStoreId },
        data: { storeStatusCode },
      });
    const before = await prisma.store.findUniqueOrThrow({
      where: { storeId: consentStoreId },
      select: { storeStatusCode: true },
    });
    await status('CLOSED');
    try {
      const res = await get(`?pageSize=200&storeIds=${consentStoreId}`);
      expect(res.body.items).toEqual([
        expect.objectContaining({ staffMemberId: null, isMasked: true }),
      ]);
      const found = await get(
        `?keyword=${encodeURIComponent('동의직원')}`,
        baId,
      );
      expect(found.body.total).toBe(0);
      await request(app.getHttpServer())
        .get(`/staff-members/${ids.consented}`)
        .set('Authorization', `Bearer ${await tokenOf(bmId)}`)
        .expect(404);
    } finally {
      await status(before.storeStatusCode);
    }
  });

  it('한 가맹 점포 안에서도 동의는 직원마다다 — 동의한 직원은 보이고 철회한 직원은 가린다', async () => {
    const res = await get(`?pageSize=200&storeIds=${mixedStoreId}`);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          staffMemberId: ids.mixedConsented,
          isMasked: false,
          name: '혼합동의',
        }),
        expect.objectContaining({
          staffMemberId: null,
          isMasked: true,
          name: null,
          phone: null,
        }),
      ]),
    );
  });

  it.each(['BM', 'BA'])(
    '%s 가 개인 칸으로 거르면 같은 점포의 철회한 직원은 건수에도 없다',
    async (role) => {
      const sub = role === 'BM' ? bmId : baId;
      const shared = await get(`?keyword=${encodeURIComponent('혼합')}`, sub);
      expect(idsOf(shared.body)).toEqual([ids.mixedConsented]);
      expect(shared.body.total).toBe(1);

      const withdrawn = await get(
        `?keyword=${encodeURIComponent('혼합철회')}`,
        sub,
      );
      expect(withdrawn.body).toEqual({ items: [], total: 0 });
    },
  );

  it('고른 점포가 가맹뿐이어도 개인 칸 필터는 동의한 직원만 찾는다', async () => {
    const consented = await get(
      `?keyword=${encodeURIComponent('동의직원')}&storeIds=${consentStoreId}`,
    );
    expect(idsOf(consented.body)).toEqual([ids.consented]);
    expect(consented.body.total).toBe(1);

    const hidden = await get(
      `?keyword=${encodeURIComponent('가맹직원')}&storeIds=${franchiseStoreId}`,
    );
    expect(hidden.body).toEqual({ items: [], total: 0 });
  });

  it('검색으로 가린 행을 찾을 수 없다', async () => {
    const res = await get(`?keyword=${encodeURIComponent('가맹직원')}`);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('가맹마스터는 자기 가맹 점포 직원을 가리지 않고 본다', async () => {
    const res = await get('', fmId);
    expect(idsOf(res.body)).toEqual([ids.franchise]);
    expect(res.body.items[0]).toMatchObject({
      isMasked: false,
      name: '가맹직원',
    });
  });

  it.each([
    ['JOINED', 'joined'],
    ['DRAFT', 'draft'],
    ['INVITED', 'invited'],
    ['AFFILIATION_PENDING', 'affiliation'],
    ['UNDER_AGE', 'underAge'],
    ['EXPIRED', 'expired'],
    ['LINK_HOLD', 'held'],
  ])('joinState=%s 필터와 표시가 같다', async (state, key) => {
    const res = await get(`?joinState=${state}&storeIds=${directStoreId}`);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toContain(ids[key]);
    for (const item of res.body.items) expect(item.joinState).toBe(state);
  });

  it('직영 점포 직원마다 표시한 상태의 필터 하나에만 걸린다', async () => {
    const scope = `storeIds=${directStoreId}&pageSize=200`;
    const hitsByState = new Map<string, (number | null)[]>();
    for (const state of STAFF_JOIN_STATES)
      hitsByState.set(
        state,
        idsOf((await get(`?joinState=${state}&${scope}`)).body),
      );
    const all = (await get(`?${scope}`)).body.items;
    expect(all.length).toBeGreaterThan(10);
    for (const item of all) {
      const hits = STAFF_JOIN_STATES.filter((s) =>
        hitsByState.get(s)?.includes(item.staffMemberId),
      );
      expect({ id: item.staffMemberId, hits }).toEqual({
        id: item.staffMemberId,
        hits: [item.joinState],
      });
    }
  });

  it('joinState 는 쉼표로 여러 상태를 받는다 — 화면의 묶음', async () => {
    const res = await get(
      `?joinState=INVITED,EXPIRED&storeIds=${directStoreId}&pageSize=200`,
    );
    expect(res.status).toBe(200);
    const found = idsOf(res.body);
    expect(found).toEqual(expect.arrayContaining([ids.invited, ids.expired]));
    expect(found).not.toContain(ids.joined);
  });

  it.each([
    ['BM', 'joinState=JOINED'],
    ['BM', 'employmentType=PART_TIME'],
    ['BA', 'keyword=%EA%B0%80%EB%A7%B9'],
    ['BA', 'joinState=JOINED'],
    ['BA', 'employmentType=PART_TIME'],
  ])('%s 가 %s 로 거르면 가맹 점포 직원은 빠진다', async (role, query) => {
    const res = await get(
      `?${query}&pageSize=200`,
      role === 'BM' ? bmId : baId,
    );
    expect(res.status).toBe(200);
    expect(franchiseRow(res.body)).toBeUndefined();
  });

  it('BP 관리자에게도 가맹 점포 직원은 가린 행이다', async () => {
    const res = await get('?pageSize=200', baId);
    const row = franchiseRow(res.body);
    expect(row).toMatchObject({
      staffMemberId: null,
      isMasked: true,
      name: null,
      phone: null,
    });
  });

  it('이미 수락한 초대는 다시 보내지 않는다 — 받은 링크로 다시 들어온다', async () => {
    const res = await get(`?pageSize=200&storeIds=${directStoreId}`);
    const row = res.body.items.find((i) => i.staffMemberId === ids.accepted);
    expect(row?.joinState).toBe('INVITED');
    expect(row?.invitation?.canResend).toBe(false);
  });

  it('대표 계약에 근무 요일이 월→일 순서, 시각 HH:mm 으로 실린다(WHALEERP-622)', async () => {
    const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: ids.draft,
        storeId: directStoreId,
        createdBy: bmId,
        status: 'SIGNED',
        startDate: new Date('2026-01-01'),
        contractStatusHistories: {
          create: { toStatus: 'SIGNED', actor: 'ADMIN' },
        },
      },
    });
    try {
      // 일부러 거꾸로 넣어 정렬을 본다
      await prisma.contractWorkDay.createMany({
        data: [
          {
            contractId,
            weekday: 'WED',
            startTime: t('10:30'),
            endTime: t('15:00'),
          },
          {
            contractId,
            weekday: 'MON',
            startTime: t('09:00'),
            endTime: t('18:00'),
            breakStartTime: t('12:00'),
            breakEndTime: t('13:00'),
          },
        ],
      });
      const res = await get(`?pageSize=200&storeIds=${directStoreId}`);
      const byId = new Map(res.body.items.map((i) => [i.staffMemberId, i]));
      expect(byId.get(ids.draft)?.contract?.workDays).toEqual([
        {
          weekday: 'MON',
          startTime: '09:00',
          endTime: '18:00',
          breakStartTime: '12:00',
          breakEndTime: '13:00',
        },
        {
          weekday: 'WED',
          startTime: '10:30',
          endTime: '15:00',
          breakStartTime: null,
          breakEndTime: null,
        },
      ]);
      // 근로계약 관리 조회 권한이 없는 관리자(직원 정보 관리 조회만 있는 그룹)에게는 근무 요일을 주지 않는다 — null.
      // 줄은 그대로 내고 workDays 칸만 null 이다(재영 결정 2026-10-27)
      const byReadOnly = await get(
        `?pageSize=200&storeIds=${directStoreId}`,
        readOnlyId,
      );
      expect(byReadOnly.status).toBe(200);
      const roRow = byReadOnly.body.items.find(
        (i) => i.staffMemberId === ids.draft,
      );
      expect(roRow?.contract?.contractId).toBe(contractId);
      expect(roRow?.contract?.workDays).toBeNull();
      // 상세도 같다
      const detailRes = await request(app.getHttpServer())
        .get(`/staff-members/${ids.draft}`)
        .set('Authorization', `Bearer ${await tokenOf(readOnlyId)}`);
      expect(detailRes.status).toBe(200);
      const detailBody = detailRes.body as StaffMemberDetailResponseDto;
      expect(detailBody.contract?.contractId).toBe(contractId);
      expect(detailBody.contract?.workDays).toBeNull();
      const detailBm = await request(app.getHttpServer())
        .get(`/staff-members/${ids.draft}`)
        .set('Authorization', `Bearer ${await tokenOf(bmId)}`);
      expect(
        (detailBm.body as StaffMemberDetailResponseDto).contract?.workDays,
      ).toHaveLength(2);
    } finally {
      await prisma.contractWorkDay.deleteMany({ where: { contractId } });
      await prisma.contractStatusHistory.deleteMany({ where: { contractId } });
      await prisma.contract.delete({ where: { contractId } });
    }
  });

  it('BP 마스터가 재직 상태로 걸러도 가린 행은 남는다', async () => {
    const res = await get('?pageSize=200&employmentStatus=EMPLOYED');
    const row = franchiseRow(res.body);
    expect(row).toMatchObject({
      staffMemberId: null,
      isMasked: true,
      name: null,
    });
  });

  // 재발송은 근로계약 재발송 api 로 나가 다시 보낼 계약(발송 대기 · 서명 대기)이 있어야 한다(WHALEERP-611) — 참인 경우는
  // contract-resend-app.e2e-spec 이 본다
  it('계약이 없는 초대 발송 직원은 재발송할 수 없고, 가입 완료 직원은 보낼 초대가 없다', async () => {
    const res = await get(`?pageSize=200&storeIds=${directStoreId}`);
    const byId = new Map(res.body.items.map((i) => [i.staffMemberId, i]));
    expect(byId.get(ids.invited)?.contract).toBeNull();
    expect(byId.get(ids.invited)?.invitation?.canResend).toBe(false);
    expect(byId.get(ids.held)?.invitation?.canResend).toBe(false);
    expect(byId.get(ids.joined)?.invitation).toBeNull();
  });

  it('만 19세 미만이었던 직원을 다시 초대하면 INVITED', async () => {
    const res = await get(`?joinState=INVITED&storeIds=${directStoreId}`);
    expect(idsOf(res.body)).toContain(ids.underAgeReinvited);
  });

  it('BP 마스터가 빈 검색어를 보내도 가린 행이 빠지지 않는다', async () => {
    const plain = await get('?pageSize=200');
    const blank = await get('?pageSize=200&keyword=%20');
    expect(blank.status).toBe(200);
    expect(blank.body.total).toBe(plain.body.total);
  });

  it('만료 뒤 재초대가 나간 직원은 INVITED 로만 나온다', async () => {
    const expired = await get(`?joinState=EXPIRED&storeIds=${directStoreId}`);
    expect(idsOf(expired.body)).not.toContain(ids.reinvited);
    const invited = await get(`?joinState=INVITED&storeIds=${directStoreId}`);
    expect(idsOf(invited.body)).toContain(ids.reinvited);
  });

  it('보류 줄은 끝 4자리와 사유만, 가입자 실명은 없다', async () => {
    const res = await get(`?joinState=LINK_HOLD&storeIds=${directStoreId}`);
    const row = res.body.items.find((i) => i.staffMemberId === ids.held);
    expect(row?.linkHold).toMatchObject({
      mismatchReason: 'PHONE_MISMATCH',
      verifiedPhoneLast4: String(n).slice(-4),
    });
    expect(JSON.stringify(res.body)).not.toContain('가입자실명');
  });

  it('범위 밖 storeIds 는 빈 목록이다(404 · 403 이 아니다)', async () => {
    const res = await get(`?storeIds=${otherBpStoreId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('마지막 페이지를 넘기면 빈 items 와 total', async () => {
    const res = await get('?page=999');
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(staffIds.length - 1);
  });

  it.each([
    'storeIds=',
    'storeIds=abc',
    'storeIds=3,,5',
    'storeIds=0',
    'storeIds=2147483648',
    'pageSize=201',
    'page=1e20',
    'page=1000001',
    'joinState=NOPE',
    'joinState=',
    'joinState=JOINED,NOPE',
    'employmentType=',
    'employmentType=FULL_TIME,NOPE',
    'unknown=1',
  ])('쿼리 형식 오류는 400 — %s', async (query) => {
    expect((await get(`?${query}`)).status).toBe(400);
  });

  it('미사용 관리자는 403', async () => {
    expect((await get('', inactiveId)).status).toBe(403);
  });

  it('직원 정보 관리 조회 권한이 없으면 403', async () => {
    expect((await get('', noReadId)).status).toBe(403);
  });

  it('토큰이 없으면 401', async () => {
    expect(
      (await request(app.getHttpServer()).get('/staff-members')).status,
    ).toBe(401);
  });

  it('직원 앱 토큰으로는 닿을 수 없다(403)', async () => {
    // 살아 있는 접속의 토큰이어야 한다 — 접속 상태가 없는 account 토큰은 종류를 따지기 전에 401 로 끝난다.
    const accountId = accountIds[0];
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: 'staff-list-e2e' });
    const token = await app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
    const res = await request(app.getHttpServer())
      .get('/staff-members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  // 본사 제공 동의는 자료를 보는 데 대한 동의라 계정 조치로 넓히지 않는다(2026-10-14 재영, api #21) — 퇴직 처리는
  // 직원 동의로, 재설정 링크 발송은 점포 단위로 판단한다.
  it.each(['BM', 'BA'] as const)(
    '%s 는 동의한 가맹 점포 직원에게 재설정 링크를 보내지 못한다(404) — 퇴직 처리 미리보기는 그대로 열린다',
    async (role) => {
      const sub = await tokenOf(role === 'BM' ? bmId : baId);
      const link = await request(app.getHttpServer())
        .post(`/staff-members/${ids.consented}/password-reset-links`)
        .set('Authorization', `Bearer ${sub}`);
      expect(link.status).toBe(404);
      expect((link.body as { message: string }).message).toBe(
        '직원을 찾을 수 없습니다.',
      );

      const preview = await request(app.getHttpServer())
        .get(
          `/staff-members/${ids.consented}/retirement-preview?retiredDate=2099-12-31`,
        )
        .set('Authorization', `Bearer ${sub}`);
      expect(preview.status).not.toBe(404);
    },
  );

  // 근로계약도 직원 목록과 같은 기준이다 — 목록이 동의한 직원 행에 내보내는 계약 ID 로 열 수 있어야 한다(api #21 리뷰).
  describe('근로계약 범위 — 직원이 정해진 계약은 직원 동의로, 새 계약 근무지는 점포 단위로', () => {
    const contractIds: Record<string, number> = {};
    beforeAll(async () => {
      for (const [key, storeId] of [
        ['consented', consentStoreId],
        ['mixedWithdrawn', mixedStoreId],
        ['franchise', franchiseStoreId],
      ] as const) {
        const c = await prisma.contract.create({
          data: { staffMemberId: ids[key], storeId, createdBy: bmId },
          select: { contractId: true },
        });
        contractIds[key] = c.contractId;
      }
    });
    const call = async (
      method: 'get' | 'post',
      path: string,
      body?: object,
    ) => {
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${await tokenOf(bmId)}`);
      return body ? req.send(body) : req;
    };

    it('BP 마스터도 동의한 가맹 점포 직원의 계약은 연다', async () => {
      const res = await call('get', `/contracts/${contractIds.consented}`);
      expect(res.status).toBe(200);
    });

    it('동의를 철회했거나 동의 없는 가맹 점포 직원의 계약은 없는 것과 같은 404', async () => {
      expect(
        (await call('get', `/contracts/${contractIds.mixedWithdrawn}`)).status,
      ).toBe(404);
      expect(
        (await call('get', `/contracts/${contractIds.franchise}`)).status,
      ).toBe(404);
    });

    it('목록에는 동의한 직원의 계약만 나온다', async () => {
      const res = await call('get', '/contracts?pageSize=200');
      const listed = (
        res.body as { items: { contractId: number }[] }
      ).items.map((i) => i.contractId);
      expect(listed).toContain(contractIds.consented);
      expect(listed).not.toContain(contractIds.mixedWithdrawn);
      expect(listed).not.toContain(contractIds.franchise);
    });

    it('새 계약은 동의한 직원이 있는 가맹 점포라도 근무지로 고를 수 없다 — 직원이 아직 없다', async () => {
      const res = await call('post', '/contracts', {
        name: '새직원',
        phone: '01055554444',
        storeId: consentStoreId,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        isTemporarySave: true,
      });
      expect(res.status).toBe(404);
      const stores = await call('get', '/stores/options?pageSize=200');
      const storeIds = (
        stores.body as { items: { storeId: number }[] }
      ).items.map((i) => i.storeId);
      expect(storeIds).toContain(directStoreId);
      expect(storeIds).not.toContain(consentStoreId);
    });

    // 같은 근무지면 범위를 점포 단위로 다시 묻지 않지만, 점포가 남아 있는지는 늘 본다(api #21 재리뷰) — 직영 점포 직원이면
    // 범위는 지나 근무지 404 다. 동의한 가맹 직원이면 폐점한 가맹 점포의 레코드는 동의해도 본사 역할에게 가려(ATT-30 v227)
    // 근무지보다 먼저 계약이 404 다. 어느 쪽이든 계약은 그대로 임시저장이다.
    it.each([
      [
        '직영 점포 직원 — 근무지 404',
        'joined',
        () => directStoreId,
        '근무지 점포를 찾을 수 없습니다.',
      ],
      [
        '동의한 가맹 점포 직원 — 계약부터 404',
        'consented',
        () => consentStoreId,
        '근로계약을 찾을 수 없습니다.',
      ],
    ] as const)(
      '임시저장 뒤 근무지가 폐점하면 같은 근무지로 이어 써도 404 — %s',
      async (_label, key, storeIdOf, message) => {
        const storeId = storeIdOf();
        const staff = await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId: ids[key] },
          select: { name: true, phone: true },
        });
        const { contractId } = await prisma.contract.create({
          data: {
            staffMemberId: ids[key],
            storeId,
            createdBy: bmId,
            status: 'DRAFT',
          },
          select: { contractId: true },
        });
        const { storeStatusCode } = await prisma.store.findUniqueOrThrow({
          where: { storeId },
          select: { storeStatusCode: true },
        });
        await prisma.store.update({
          where: { storeId },
          data: { storeStatusCode: 'CLOSED' },
        });
        try {
          const res = await request(app.getHttpServer())
            .put(`/contracts/${contractId}`)
            .set('Authorization', `Bearer ${await tokenOf(bmId)}`)
            .send({
              name: staff.name,
              phone: staff.phone,
              storeId,
              jobTitle: '홀',
              employmentType: 'PART_TIME',
              contractMethod: 'ELECTRONIC',
              isTemporarySave: true,
            });
          expect(res.status).toBe(404);
          expect((res.body as { message: string }).message).toBe(message);
          const after = await prisma.contract.findUniqueOrThrow({
            where: { contractId },
            select: { status: true },
          });
          expect(after.status).toBe('DRAFT');
        } finally {
          await prisma.store.update({
            where: { storeId },
            data: { storeStatusCode },
          });
          // 뒤 시험의 최근 계약 · 가입 상태가 이 임시저장에 흔들리지 않게 지운다
          await prisma.contract.delete({ where: { contractId } });
        }
      },
    );
  });
  describe('직원 상세 GET /staff-members/:id (WHALEERP-599)', () => {
    /** 응답 본문은 any 라 상세 응답 DTO 모양을 붙여 돌려준다. */
    const getOne = async (id: number | string, sub = bmId) => {
      const res = await request(app.getHttpServer())
        .get(`/staff-members/${id}`)
        .set('Authorization', `Bearer ${await tokenOf(sub)}`);
      return {
        status: res.status,
        body: res.body as StaffMemberDetailResponseDto & { message?: string },
      };
    };

    it('목록의 같은 직원 줄과 같은 값이다 — 초대 · 보류 · 가입 상태를 따로 계산하지 않는다', async () => {
      const list = await get('?pageSize=200');
      for (const key of ['joined', 'invited', 'held', 'accepted', 'draft']) {
        const listed = list.body.items.find(
          (i) => i.staffMemberId === ids[key],
        );
        const res = await getOne(ids[key]);
        expect([key, res.status]).toEqual([key, 200]);
        // 이 직원들은 연결된 계정 · 생년월일 적은 계약이 없다 — 상세가 더하는 칸(이메일 · 기본 정보, WHALEERP-183)만 다르다.
        expect(res.body).toEqual({
          ...listed,
          email: null,
          jobTitle: '홀',
          hiredDate: null,
          birthDate: null,
          // 계정이 없다 — 정정할 수 없다(WHALEERP-602)
          birthDateCorrectable: false,
          // 이 직원들은 직영 점포 직원이다
          hqSharingConsent: null,
          // 재입사로 이은 레코드가 없다(WHALEERP-615)
          previousRecords: [],
          laterRecords: [],
        });
        expect(res.body.isMasked).toBe(false);
      }
    });

    // 비밀번호 초기화 확인창이 「재설정 링크가 이메일 아이디 OOO 으로 발송됩니다」에 쓴다(WHALEERP-177).
    it('계정에 연결된 직원은 계정 이메일을 내고, 탈퇴 계정은 null 이다 — 목록 줄에는 이메일 칸이 없다', async () => {
      const linked = async (key: string, status: 'JOINED' | 'WITHDRAWN') => {
        const account = await prisma.account.create({
          data: {
            email: `${key}-${n}@test.invalid`,
            passwordHash: '!',
            realName: '계정직원',
            birthDate: new Date('1990-01-01'),
            phone: `010${randomInt(10_000_000, 99_999_999)}`,
            status,
          },
        });
        accountIds.push(account.accountId);
        const { staffMemberId } = await prisma.staffMember.create({
          data: {
            storeId: directStoreId,
            accountId: account.accountId,
            name: '계정직원',
            phone: account.phone,
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            joinStatus: 'JOINED',
          },
        });
        staffIds.push(staffMemberId);
        ids[key] = staffMemberId;
        return account.email;
      };
      const email = await linked('linkedjoined', 'JOINED');
      await linked('linkedwithdrawn', 'WITHDRAWN');

      expect((await getOne(ids.linkedjoined)).body.email).toBe(email);
      expect((await getOne(ids.linkedwithdrawn)).body.email).toBeNull();
      // WHALEERP-602: 직원 레코드는 JOINED 여도 탈퇴 계정이면 정정할 수 없다
      expect((await getOne(ids.linkedjoined)).body.birthDateCorrectable).toBe(
        true,
      );
      expect(
        (await getOne(ids.linkedwithdrawn)).body.birthDateCorrectable,
      ).toBe(false);
      const listed = (await get('?pageSize=200')).body.items.find(
        (i) => i.staffMemberId === ids.linkedjoined,
      );
      expect(listed).toBeDefined();
      expect(listed).not.toHaveProperty('email');
    });

    // 동의는 자료를 보는 데 대한 것이라 계정 정보로 넓히지 않는다(ATT-30). 본사 역할은 동의한 가맹 점포 직원의 상세는
    // 열지만 이메일은 받지 않는다 — 재설정 링크(404)와 같은 점포 기준이다.
    it('동의한 가맹 점포 직원의 이메일은 본사 역할(BM · BA)에게 null, 가맹마스터에게는 주소다', async () => {
      const account = await prisma.account.create({
        data: {
          email: `fcconsent-${n}@test.invalid`,
          passwordHash: '!',
          realName: '가맹동의직원',
          birthDate: new Date('1990-01-01'),
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          status: 'JOINED',
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date(),
        },
      });
      accountIds.push(account.accountId);
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: franchiseStoreId,
          accountId: account.accountId,
          name: '가맹동의직원',
          phone: account.phone,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
        },
      });
      staffIds.push(staffMemberId);

      for (const sub of [bmId, baId]) {
        const res = await getOne(staffMemberId, sub);
        expect([sub, res.status, res.body.email]).toEqual([sub, 200, null]);
      }
      const byFm = await getOne(staffMemberId, fmId);
      expect([byFm.status, byFm.body.email]).toEqual([200, account.email]);
    });

    // 이메일은 회원 ID 다. 근무지에서 직원을 마주한 관리자가 알려 주므로 조회 권한만으로 보인다(WHALEERP-180, ACC-16).
    // 퇴직 레코드는 수정 권한자에게도 null 이다(2026-10-16 영주).
    it('조회만 있는 관리자도 상세에서 이메일을 받고, 퇴직 레코드의 이메일은 수정 권한자에게도 null 이다', async () => {
      const linkedRecord = async (key: string, retired: boolean) => {
        const account = await prisma.account.create({
          data: {
            email: `${key}-${n}@test.invalid`,
            passwordHash: '!',
            realName: '계정직원',
            birthDate: new Date('1990-01-01'),
            phone: `010${randomInt(10_000_000, 99_999_999)}`,
            status: 'JOINED',
          },
        });
        accountIds.push(account.accountId);
        const { staffMemberId } = await prisma.staffMember.create({
          data: {
            storeId: directStoreId,
            accountId: account.accountId,
            name: '계정직원',
            phone: account.phone,
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            joinStatus: 'JOINED',
            ...(retired
              ? {
                  employmentStatus: 'RETIRED' as const,
                  retiredDate: new Date('2026-01-31'),
                }
              : {}),
          },
        });
        staffIds.push(staffMemberId);
        return { staffMemberId, email: account.email };
      };
      const active = await linkedRecord('readonlyview', false);
      const retired = await linkedRecord('retiredview', true);

      const byReadOnly = await getOne(active.staffMemberId, readOnlyId);
      expect([byReadOnly.status, byReadOnly.body.email]).toEqual([
        200,
        active.email,
      ]);
      expect((await getOne(active.staffMemberId)).body.email).toBe(
        active.email,
      );
      const byBm = await getOne(retired.staffMemberId);
      expect([byBm.status, byBm.body.email]).toEqual([200, null]);
    });

    it('다른 BP 직원 · 없는 직원은 같은 404', async () => {
      for (const id of [ids.otherBp, 2_147_483_647]) {
        const res = await getOne(id);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('직원을 찾을 수 없습니다.');
      }
    });

    it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])(
      'ID 형식 오류 %p 는 404 — 500 이 되지 않는다',
      async (raw) => {
        expect((await getOne(raw)).status).toBe(404);
      },
    );

    it('BP 마스터 · BP 관리자에게 가려지는 가맹 점포 직원은 404 — 동의한 직원은 연다', async () => {
      for (const sub of [bmId, baId]) {
        expect((await getOne(ids.franchise, sub)).status).toBe(404);
        expect((await getOne(ids.mixedWithdrawn, sub)).status).toBe(404);
        expect((await getOne(ids.consented, sub)).status).toBe(200);
        expect((await getOne(ids.mixedConsented, sub)).status).toBe(200);
      }
    });

    it('가맹마스터는 매핑된 자기 가맹 점포 직원을 열고, 매핑 밖 직영 점포 직원은 404', async () => {
      const res = await getOne(ids.franchise, fmId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        staffMemberId: ids.franchise,
        isMasked: false,
        name: '가맹직원',
      });
      expect((await getOne(ids.joined, fmId)).status).toBe(404);
    });

    // 권한은 가드가 범위보다 먼저 본다. 없는 직원 · 범위 안 직원 모두 같은 403 이라 응답으로 id 가 갈리지 않는다.
    it('조회 권한이 없으면 어떤 id 든 403', async () => {
      for (const id of [ids.joined, ids.otherBp, 2_147_483_647, 'abc'])
        expect((await getOne(id, noReadId)).status).toBe(403);
    });

    it('미사용 관리자는 403, 토큰이 없으면 401', async () => {
      expect((await getOne(ids.joined, inactiveId)).status).toBe(403);
      expect(
        (await request(app.getHttpServer()).get(`/staff-members/${ids.joined}`))
          .status,
      ).toBe(401);
    });
  });

  // 관리 범위의 경계(WHALEERP-187). 상세 · 목록은 같은 관리 범위(getManageableStores)를 쓴다 — 매핑으로 일부 점포만 맡은
  // 관리자, 지운 매핑, 다른 BP 점포를 가리키는 매핑, 지운 점포, 가맹관리자, 플랫폼 마스터, 직원 앱 토큰을 실제 DB 로 본다.
  // 앞 테스트의 목록 건수를 바꾸지 않게 맨 뒤에 두고, 만든 것은 여기서 지운다. 가맹 점포(franchiseStoreId)에 직원을
  // 더하므로 「가맹 점포에는 한 명뿐」을 전제로 하는 franchiseRow 를 쓰는 테스트는 이 블록 앞에 둔다.
  describe('관리 범위 경계 (WHALEERP-187)', () => {
    let deletedStoreId: number;
    let deletedStoreStaffId: number;
    let faRoleGroupId: number;
    let faId: number; // 가맹관리자, 가맹 점포 매핑, 직원 정보 관리 조회만
    let directMappedBaId: number; // BP 관리자, 직영 점포만 매핑
    let deletedMappingBaId: number; // BP 관리자, 직영 점포 매핑을 지움
    let crossBpBaId: number; // BP 관리자, 다른 BP 점포를 가리키는 매핑
    let pmId: number; // 플랫폼 마스터(PM, PM000001) — 시드에 PA 그룹은 없다
    let faStaff: { staffMemberId: number; email: string };
    const scopeAdminIds: number[] = [];
    const scopeStaffIds: number[] = [];
    const scopeAccountIds: number[] = [];

    const getOne = async (id: number, sub: number) =>
      (await request(app.getHttpServer())
        .get(`/staff-members/${id}`)
        .set('Authorization', `Bearer ${await tokenOf(sub)}`)) as {
        status: number;
        body: StaffMemberDetailResponseDto;
      };

    beforeAll(async () => {
      const groupOf = async (roleCode: string) =>
        (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
          .roleGroupId;
      const scopeAdmin = async (
        loginId: string,
        data: {
          bpCodeId?: number;
          roleTypeCode: string;
          roleGroupId: number;
          isAllStores?: boolean;
          mapping?: { storeId: number; isDeleted?: boolean };
        },
      ) => {
        const a = await prisma.adminAccount.create({
          data: {
            loginId,
            bpCodeId: data.bpCodeId ?? bpCodeId,
            passwordHash: '!',
            roleTypeCode: data.roleTypeCode,
            roleGroupId: data.roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
            isAllStores: data.isAllStores ?? false,
            ...(data.mapping
              ? { storeMappings: { create: data.mapping } }
              : {}),
          },
        });
        scopeAdminIds.push(a.adminAccountId);
        return a.adminAccountId;
      };

      ({ storeId: deletedStoreId } = await prisma.store.create({
        data: {
          // store_code CHECK 는 `^ST[0-9]{6}$` 다 — n + 5 가 1_000_000 을 넘어 작은 수로 돌면 자릿수가 모자라 6자리로 채운다.
          storeCode: `ST${String((n + 5) % 1_000_000).padStart(6, '0')}`,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name: '지운 점포',
          storeStatusCode: 'OPERATING',
          isDeleted: true,
        },
      }));
      ({ staffMemberId: deletedStoreStaffId } = await prisma.staffMember.create(
        {
          data: {
            storeId: deletedStoreId,
            name: '지운점포직원',
            phone: `010${randomInt(10_000_000, 99_999_999)}`,
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            joinStatus: 'JOINED',
          },
        },
      ));
      scopeStaffIds.push(deletedStoreStaffId);

      // 가맹관리자(FA) 권한 그룹은 시드에 없다 — 각 BP 가 화면에서 만든다. 여기서는 직원 정보 관리 조회만 켠 그룹을 만든다.
      const staffMenu = await prisma.menu.findFirstOrThrow({
        where: { menuCode: 'MN000005' },
      });
      ({ roleGroupId: faRoleGroupId } = await prisma.roleGroup.create({
        data: {
          roleCode: `FA${String(n).padStart(6, '0')}`,
          bpCodeId,
          roleTypeCode: 'FA',
          name: `가맹관리자 조회 ${n}`,
          menus: {
            create: {
              menuId: staffMenu.menuId,
              isReadable: true,
              isUpdatable: false,
            },
          },
        },
      }));
      faId = await scopeAdmin(`scopefa${n}`, {
        roleTypeCode: 'FA',
        roleGroupId: faRoleGroupId,
        mapping: { storeId: franchiseStoreId },
      });
      const bmGroup = await groupOf('BM000001');
      directMappedBaId = await scopeAdmin(`scopebadirect${n}`, {
        roleTypeCode: 'BA',
        roleGroupId: bmGroup,
        mapping: { storeId: directStoreId },
      });
      deletedMappingBaId = await scopeAdmin(`scopebadel${n}`, {
        roleTypeCode: 'BA',
        roleGroupId: bmGroup,
        mapping: { storeId: directStoreId, isDeleted: true },
      });
      crossBpBaId = await scopeAdmin(`scopebacross${n}`, {
        roleTypeCode: 'BA',
        roleGroupId: bmGroup,
        mapping: { storeId: otherBpStoreId },
      });
      const platform = await prisma.bpCode.findFirstOrThrow({
        where: { isPlatform: true },
      });
      pmId = await scopeAdmin(`scopepm${n}`, {
        bpCodeId: platform.bpCodeId,
        roleTypeCode: 'PM',
        roleGroupId: await groupOf('PM000001'),
        isAllStores: true,
      });

      // 동의하지 않은 가맹 점포 직원 — 가맹 역할은 동의와 상관없이 보고, 이메일도 받는다.
      const account = await prisma.account.create({
        data: {
          email: `scopefa-${n}@test.invalid`,
          passwordHash: '!',
          realName: '가맹관리자직원',
          birthDate: new Date('1990-01-01'),
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          status: 'JOINED',
        },
      });
      scopeAccountIds.push(account.accountId);
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: franchiseStoreId,
          accountId: account.accountId,
          name: '가맹관리자직원',
          phone: account.phone,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
        },
      });
      scopeStaffIds.push(staffMemberId);
      faStaff = { staffMemberId, email: account.email };
    });

    afterAll(async () => {
      await prisma.staffMember.deleteMany({
        where: { staffMemberId: { in: scopeStaffIds } },
      });
      await prisma.authSession.deleteMany({
        where: { accountId: { in: scopeAccountIds } },
      });
      await prisma.account.deleteMany({
        where: { accountId: { in: scopeAccountIds } },
      });
      const byAdmin = { adminAccountId: { in: scopeAdminIds } };
      await prisma.adminStoreMapping.deleteMany({ where: byAdmin });
      await prisma.adminSession.deleteMany({ where: byAdmin });
      await prisma.adminAccount.deleteMany({ where: byAdmin });
      if (faRoleGroupId) {
        await prisma.roleGroupMenu.deleteMany({
          where: { roleGroupId: faRoleGroupId },
        });
        await prisma.roleGroup.delete({
          where: { roleGroupId: faRoleGroupId },
        });
      }
      if (deletedStoreId)
        await prisma.store.delete({ where: { storeId: deletedStoreId } });
    });

    it('직영 점포만 매핑한 BP 관리자는 그 점포 직원만 연다 — 같은 BP 의 매핑 밖 점포와 다른 BP 직원은 404', async () => {
      expect((await getOne(ids.joined, directMappedBaId)).status).toBe(200);
      // 동의한 직원이라 전체 점포 BP 관리자에게는 열린다(위 테스트). 여기서 막는 것은 매핑이다.
      expect((await getOne(ids.consented, directMappedBaId)).status).toBe(404);
      expect((await getOne(ids.otherBp, directMappedBaId)).status).toBe(404);
      const list = await get('?pageSize=200', directMappedBaId);
      expect(idsOf(list.body)).toContain(ids.joined);
      expect(
        list.body.items.every((i) => i.store.storeId === directStoreId),
      ).toBe(true);
    });

    it('지운 매핑으로는 그 점포 직원을 열 수 없다 — 목록도 비어 있다', async () => {
      expect((await getOne(ids.joined, deletedMappingBaId)).status).toBe(404);
      expect((await get('', deletedMappingBaId)).body).toEqual({
        items: [],
        total: 0,
      });
    });

    // 매핑이 BP 를 넘지 않는다는 보장은 DB 에 없다. 관리 범위가 자기 BP 의 점포로 다시 거른다.
    it('다른 BP 점포를 가리키는 매핑으로는 그 BP 직원을 열 수 없다', async () => {
      expect((await getOne(ids.otherBp, crossBpBaId)).status).toBe(404);
      expect((await get('', crossBpBaId)).body).toEqual({
        items: [],
        total: 0,
      });
    });

    it('지운 점포의 직원은 전체 점포 BP 마스터에게도 404 이고 목록에도 없다', async () => {
      expect((await getOne(deletedStoreStaffId, bmId)).status).toBe(404);
      expect(idsOf((await get('?pageSize=200', bmId)).body)).not.toContain(
        deletedStoreStaffId,
      );
    });

    it('조회를 켠 가맹관리자는 매핑된 가맹 점포 직원을 동의와 상관없이 열고 이메일도 받는다 — 매핑 밖은 404', async () => {
      const res = await getOne(faStaff.staffMemberId, faId);
      expect([res.status, res.body.isMasked, res.body.email]).toEqual([
        200,
        false,
        faStaff.email,
      ]);
      expect((await getOne(ids.franchise, faId)).status).toBe(200);
      expect((await getOne(ids.joined, faId)).status).toBe(404);
      expect((await getOne(ids.consented, faId)).status).toBe(404);
    });

    // 플랫폼 관리자(PM · PA)가 고객 BP 직원을 다루는 범위는 아직 정하지 않았다(WHALEERP-301). 관리 범위가 소속 BP 의 점포로
    // 묶여 고객 BP 점포가 들지 않으므로 조회 권한이 있어도 고객 BP 직원을 보지 못한다. 범위가 정해지면 이 테스트가
    // 바뀐다. 플랫폼 BP 점포의 직원은 다른 e2e 가 만들 수 있어(account-status-policy) 목록 전체가 비었는지는 보지
    // 않고, 이 파일의 고객 BP 점포로만 묻는다.
    it('플랫폼 마스터(PM)는 조회 권한이 있어도 고객 BP 직원을 보지 못한다 — 목록에 없고 상세는 404', async () => {
      const customerStoreIds = [
        directStoreId,
        franchiseStoreId,
        consentStoreId,
        mixedStoreId,
        otherBpStoreId,
      ];
      const list = await get(`?storeIds=${customerStoreIds.join(',')}`, pmId);
      expect([list.status, list.body]).toEqual([200, { items: [], total: 0 }]);
      for (const id of [ids.joined, ids.consented, ids.otherBp])
        expect([id, (await getOne(id, pmId)).status]).toEqual([id, 404]);
    });

    // 거부는 컨트롤러의 @MenuPermission 이 함께 붙이는 UserTypes('admin') 를 보고 전역 JwtAuthGuard 가 낸다(목록
    // 테스트와 같은 403). 상세 경로에도 그 데코레이터가 걸려 있음을 고정한다 — 경로 단위로 옮기다 상세만 빠지면 직원 앱
    // 토큰이 핸들러까지 간다.
    it('직원 앱 토큰으로는 상세에도 닿을 수 없다(403)', async () => {
      // 살아 있는 접속의 토큰이어야 한다 — 접속 상태가 없는 account 토큰은 종류를 따지기 전에 401 로 끝난다.
      const accountId = scopeAccountIds[0];
      const session = await app
        .get(AuthSessionService)
        .issue({ accountId, deviceIdentifier: 'staff-detail-e2e' });
      const token = await app.get(JwtService).signAsync({
        sub: accountId,
        type: 'account',
        email: 'staff@test.invalid',
        typ: 'access',
        sid: session.authSessionId,
      });
      const res = await request(app.getHttpServer())
        .get(`/staff-members/${faStaff.staffMemberId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });

  // 본사 제공 동의는 계정에 하나다(2026-10-20) — 같은 계정의 두 가맹 점포 레코드가 함께 보이고 함께 가려진다. 가입 전
  // (계정 없음) 직원은 동의하지 않은 것으로 본다. 관계 조건(account is …)이 계정 없는 행을 어떻게 푸는지는 실제 DB 만 증명한다.
  // 앞의 건수 테스트를 흔들지 않도록 점포 · 직원 · 계정을 따로 만들고 따로 지운다.
  describe('본사 제공 동의는 계정 단위 — 모든 소속에 같이 적용', () => {
    let storeA: number;
    let storeB: number;
    let storeC: number; // 다른 BP 의 가맹 점포
    let otherBmId: number; // 다른 BP 의 BP 마스터
    let accountId: number;
    let staffA: number;
    let staffB: number;
    let staffC: number;
    const ownStaff: number[] = [];
    const preJoinName = `가입전가맹${n}`;

    beforeAll(async () => {
      const store = async (code: number, name: string, bp = bpCodeId) =>
        (
          await prisma.store.create({
            data: {
              storeCode: `ST${code}`,
              bpCodeId: bp,
              storeTypeCode: 'FRANCHISE',
              name,
              storeStatusCode: 'OPERATING',
            },
          })
        ).storeId;
      storeA = await store((n + 5) % 1_000_000, '동의 공유 가맹점 A');
      storeB = await store((n + 6) % 1_000_000, '동의 공유 가맹점 B');
      storeC = await store((n + 7) % 1_000_000, '다른 BP 가맹점', otherBpId);
      ({ adminAccountId: otherBmId } = await prisma.adminAccount.create({
        data: {
          loginId: `listobm${n}`,
          bpCodeId: otherBpId,
          passwordHash: '!',
          roleTypeCode: 'BM',
          roleGroupId: (
            await prisma.roleGroup.findFirstOrThrow({
              where: { roleCode: 'BM000001' },
            })
          ).roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      }));
      const phone = `010${randomInt(10_000_000, 99_999_999)}`;
      ({ accountId } = await prisma.account.create({
        data: {
          email: `share-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '두소속',
          birthDate: new Date('1990-01-01'),
          phone,
          status: 'JOINED',
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date('2026-10-01T00:00:00Z'),
        },
      }));
      const staff = async (
        storeId: number,
        name: string,
        joinStatus: 'INVITED' | 'JOINED',
        linked: number | null,
      ) => {
        const s = await prisma.staffMember.create({
          data: {
            storeId,
            name,
            phone: `010${randomInt(10_000_000, 99_999_999)}`,
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            joinStatus,
            accountId: linked,
          },
        });
        ownStaff.push(s.staffMemberId);
        return s.staffMemberId;
      };
      staffA = await staff(storeA, '두소속A', 'JOINED', accountId);
      staffB = await staff(storeB, '두소속B', 'JOINED', accountId);
      staffC = await staff(storeC, '두소속C', 'JOINED', accountId);
      await staff(storeA, preJoinName, 'INVITED', null);
    });

    afterAll(async () => {
      await prisma.staffMember.deleteMany({
        where: { staffMemberId: { in: ownStaff } },
      });
      await prisma.account.deleteMany({ where: { accountId } });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: otherBmId },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: otherBmId },
      });
      await prisma.store.deleteMany({
        where: { storeId: { in: [storeA, storeB, storeC] } },
      });
    });

    const detailStatus = async (id: number, sub: number) =>
      (
        await request(app.getHttpServer())
          .get(`/staff-members/${id}`)
          .set('Authorization', `Bearer ${await tokenOf(sub)}`)
      ).status;
    const visibleIds = async (sub: number) => {
      const res = await get(`?pageSize=200&storeIds=${storeA},${storeB}`, sub);
      return res.body.items
        .filter((i) => !i.isMasked)
        .map((i) => i.staffMemberId)
        .sort((a, b) => (a ?? 0) - (b ?? 0));
    };

    it('동의한 계정의 두 가맹 점포 레코드는 BP 마스터 · BP 관리자에게 모두 보인다', async () => {
      for (const sub of [bmId, baId]) {
        expect(await visibleIds(sub)).toEqual([staffA, staffB]);
        expect(await detailStatus(staffA, sub)).toBe(200);
        expect(await detailStatus(staffB, sub)).toBe(200);
      }
    });

    // 동의는 모든 BP 에 같은 값이지만, 각 본사는 자기 BP 점포의 레코드만 본다(2026-10-20 노영주).
    it('동의는 BP 를 넘어 같은 값이지만, 각 본사는 자기 BP 점포에 있는 레코드만 본다', async () => {
      const other = await get(`?pageSize=200&storeIds=${storeC}`, otherBmId);
      expect(
        other.body.items.filter((i) => !i.isMasked).map((i) => i.staffMemberId),
      ).toEqual([staffC]);
      expect(await detailStatus(staffC, otherBmId)).toBe(200);
      expect(await detailStatus(staffA, otherBmId)).toBe(404);
      expect(await detailStatus(staffB, otherBmId)).toBe(404);
      expect(await detailStatus(staffC, bmId)).toBe(404);
    });

    it('가입 전(계정 없음) 가맹 점포 직원은 가린 행이고, 검색으로도 찾을 수 없다', async () => {
      const list = await get(`?pageSize=200&storeIds=${storeA}`);
      expect(list.body.total).toBe(2);
      expect(list.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            staffMemberId: null,
            isMasked: true,
            name: null,
          }),
        ]),
      );
      for (const sub of [bmId, baId]) {
        const found = await get(
          `?keyword=${encodeURIComponent(preJoinName)}`,
          sub,
        );
        expect(found.body).toEqual({ items: [], total: 0 });
      }
    });

    it('계정에서 철회하면 두 소속이 함께 가려진다', async () => {
      await prisma.account.update({
        where: { accountId },
        data: {
          isHqSharingConsented: false,
          hqSharingWithdrawnAt: new Date('2026-10-05T00:00:00Z'),
        },
      });
      for (const sub of [bmId, baId]) {
        expect(await visibleIds(sub)).toEqual([]);
        expect(await detailStatus(staffA, sub)).toBe(404);
        expect(await detailStatus(staffB, sub)).toBe(404);
        const found = await get(
          `?keyword=${encodeURIComponent('두소속')}`,
          sub,
        );
        expect(found.body).toEqual({ items: [], total: 0 });
      }
      expect(await detailStatus(staffC, otherBmId)).toBe(404);
    });
  });

  // 재직 이력(WHALEERP-615). 재입사하면 새 레코드가 생기고 previous_staff_member_id 로 직전 재직 레코드를 잇는다 —
  // 상세는 그 사슬을 따라 이전 · 이후 재직 기간을 낸다. 목록은 그대로다(2026-10-22 재영 C안). 앞 테스트의 목록 건수를
  // 바꾸지 않게 맨 뒤에 두고, 만든 것은 여기서 지운다.
  describe('재직 이력 (WHALEERP-615)', () => {
    const own: number[] = [];
    const record = async (
      store: number,
      data: {
        hired: string;
        retired?: string;
        previous?: number;
        accountId?: number;
        /** 체결 완료된 계약을 함께 만든다 — 재직 이력은 체결 완료된 레코드만 낸다. 기본 true */
        signed?: boolean;
      },
    ) => {
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: store,
          accountId: data.accountId ?? null,
          name: '재입사직원',
          phone: `010${n}99`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: data.accountId ? 'JOINED' : 'DRAFT',
          hiredDate: new Date(data.hired),
          employmentStatus: data.retired ? 'RETIRED' : 'EMPLOYED',
          retiredDate: data.retired ? new Date(data.retired) : null,
          previousStaffMemberId: data.previous ?? null,
        },
      });
      own.push(staffMemberId);
      const signed = data.signed ?? true;
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId: store,
          createdBy: bmId,
          status: signed ? 'SIGNED' : 'DRAFT',
          startDate: new Date(data.hired),
          contractStatusHistories: {
            create: { toStatus: signed ? 'SIGNED' : 'DRAFT', actor: 'ADMIN' },
          },
        },
      });
      return staffMemberId;
    };
    const detail = async (id: number, sub = bmId) => {
      const res = await request(app.getHttpServer())
        .get(`/staff-members/${id}`)
        .set('Authorization', `Bearer ${await tokenOf(sub)}`);
      expect(res.status).toBe(200);
      return res.body as StaffMemberDetailResponseDto;
    };

    afterAll(async () => {
      const byStaff = { staffMemberId: { in: own } };
      await prisma.contractStatusHistory.deleteMany({
        where: { contract: byStaff },
      });
      await prisma.contract.deleteMany({ where: byStaff });
      // 이전 재직 레코드 외래키(RESTRICT)가 걸려 있어 나중 레코드부터 지운다
      for (const staffMemberId of [...own].reverse())
        await prisma.staffMember.delete({ where: { staffMemberId } });
    });

    it('사슬을 따라 이전 재직 기간은 가까운 것부터, 이후 재직 기간은 가까운 것부터 낸다', async () => {
      const first = await record(directStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
      });
      const second = await record(directStoreId, {
        hired: '2025-09-01',
        retired: '2026-02-28',
        previous: first,
      });
      const third = await record(directStoreId, {
        hired: '2026-05-01',
        previous: second,
      });
      const period = (staffMemberId: number, h: string, r: string | null) => ({
        staffMemberId,
        hiredDate: h,
        retiredDate: r,
      });

      const now = await detail(third);
      expect(now.previousRecords).toEqual([
        period(second, '2025-09-01', '2026-02-28'),
        period(first, '2025-01-02', '2025-06-30'),
      ]);
      expect(now.laterRecords).toEqual([]);

      const oldest = await detail(first);
      expect(oldest.previousRecords).toEqual([]);
      expect(oldest.laterRecords).toEqual([
        period(second, '2025-09-01', '2026-02-28'),
        period(third, '2026-05-01', null),
      ]);

      const middle = await detail(second);
      expect(middle.previousRecords).toEqual([
        period(first, '2025-01-02', '2025-06-30'),
      ]);
      expect(middle.laterRecords).toEqual([period(third, '2026-05-01', null)]);
    });

    it('체결 완료된 계약이 없는 재입사 레코드(임시저장 · 발송만)는 재직 이력에 내지 않는다 (2026-10-23 김민식)', async () => {
      const first = await record(directStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
      });
      const draft = await record(directStoreId, {
        hired: '2026-04-01',
        previous: first,
        signed: false,
      });

      expect((await detail(first)).laterRecords).toEqual([]);
      // 임시저장 레코드의 상세에서는 체결 완료된 옛 재직 기간이 보인다
      expect((await detail(draft)).previousRecords).toEqual([
        {
          staffMemberId: first,
          hiredDate: '2025-01-02',
          retiredDate: '2025-06-30',
        },
      ]);
    });

    it('체결 없이 퇴직한 레코드가 사이에 있어도 양쪽 모두 건너서 따라간다', async () => {
      const first = await record(directStoreId, {
        hired: '2024-01-02',
        retired: '2024-06-30',
      });
      const unsigned = await record(directStoreId, {
        hired: '2025-01-02',
        retired: '2025-02-28',
        previous: first,
        signed: false,
      });
      const last = await record(directStoreId, {
        hired: '2026-03-01',
        previous: unsigned,
      });

      expect((await detail(first)).laterRecords).toEqual([
        { staffMemberId: last, hiredDate: '2026-03-01', retiredDate: null },
      ]);
      expect((await detail(last)).previousRecords).toEqual([
        {
          staffMemberId: first,
          hiredDate: '2024-01-02',
          retiredDate: '2024-06-30',
        },
      ]);
    });

    // 저장은 서로 가리키지 않게 잇지만, 손으로 고친 값 같은 다른 길로 사슬이 돌아도 상세가 멈춘다
    it('사슬이 돌면 한 바퀴에서 멈춘다', async () => {
      const a = await record(directStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
      });
      const b = await record(directStoreId, {
        hired: '2025-09-01',
        retired: '2026-02-28',
        previous: a,
      });
      await prisma.staffMember.update({
        where: { staffMemberId: a },
        data: { previousStaffMemberId: b },
      });

      const body = await detail(a);
      expect(body.previousRecords).toEqual([
        {
          staffMemberId: b,
          hiredDate: '2025-09-01',
          retiredDate: '2026-02-28',
        },
      ]);
      expect(body.laterRecords).toEqual([
        {
          staffMemberId: b,
          hiredDate: '2025-09-01',
          retiredDate: '2026-02-28',
        },
      ]);
      // 지우기 전에 순환을 푼다 — 외래키(RESTRICT)가 서로 걸려 있다
      await prisma.staffMember.update({
        where: { staffMemberId: a },
        data: { previousStaffMemberId: null },
      });
    });

    it('이었던 레코드가 없으면 둘 다 빈 목록이다', async () => {
      const alone = await record(directStoreId, { hired: '2026-01-05' });
      const body = await detail(alone);
      expect(body.previousRecords).toEqual([]);
      expect(body.laterRecords).toEqual([]);
    });

    it('이 관리자에게 가려지는 재직 기간은 빼고 낸다 — 본사 역할에게 동의 없는 가입 전 레코드', async () => {
      const { accountId } = await prisma.account.create({
        data: {
          email: `rehire-${n}@test.invalid`,
          passwordHash: '!',
          realName: '재입사직원',
          birthDate: new Date('1990-01-01'),
          phone: `010${n}98`,
          status: 'JOINED',
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date(),
        },
      });
      accountIds.push(accountId);
      const before = await record(consentStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
      });
      const after = await record(consentStoreId, {
        hired: '2026-03-01',
        previous: before,
        accountId,
      });

      expect((await detail(after)).previousRecords).toEqual([]);
    });

    it('가려지는 칸은 빼고 그 앞의 보이는 재직 기간까지 따라간다', async () => {
      const consented = async (suffix: string) => {
        const { accountId } = await prisma.account.create({
          data: {
            email: `rehire-${suffix}-${n}@test.invalid`,
            passwordHash: '!',
            realName: '재입사직원',
            birthDate: new Date('1990-01-01'),
            phone: `010${n}97`,
            status: 'JOINED',
            isHqSharingConsented: true,
            hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
            hqSharingAgreedAt: new Date(),
          },
        });
        accountIds.push(accountId);
        return accountId;
      };
      const oldest = await record(consentStoreId, {
        hired: '2024-01-02',
        retired: '2024-06-30',
        accountId: await consented('a'),
      });
      const hidden = await record(consentStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
        previous: oldest,
      });
      const newest = await record(consentStoreId, {
        hired: '2026-03-01',
        previous: hidden,
        accountId: await consented('b'),
      });

      expect((await detail(newest)).previousRecords).toEqual([
        {
          staffMemberId: oldest,
          hiredDate: '2024-01-02',
          retiredDate: '2024-06-30',
        },
      ]);
      expect((await detail(oldest)).laterRecords).toEqual([
        { staffMemberId: newest, hiredDate: '2026-03-01', retiredDate: null },
      ]);
    });

    it('한 레코드를 이은 레코드가 둘이면 이후 재직 기간에 둘 다 낸다 — 걸음 수, 같으면 만든 순서', async () => {
      const first = await record(directStoreId, {
        hired: '2025-01-02',
        retired: '2025-06-30',
      });
      const one = await record(directStoreId, {
        hired: '2026-01-05',
        retired: '2026-01-31',
        previous: first,
      });
      const two = await record(directStoreId, {
        hired: '2026-02-02',
        previous: first,
      });
      const afterOne = await record(directStoreId, {
        hired: '2026-03-02',
        previous: one,
      });

      expect((await detail(first)).laterRecords).toEqual([
        {
          staffMemberId: one,
          hiredDate: '2026-01-05',
          retiredDate: '2026-01-31',
        },
        { staffMemberId: two, hiredDate: '2026-02-02', retiredDate: null },
        { staffMemberId: afterOne, hiredDate: '2026-03-02', retiredDate: null },
      ]);
    });
  });

  // 상단 점포 범위 연동(2026-10-22 재영) — 점포 유형(storeTypes)은 그 유형 · 폐점 아닌 점포만, storeIds 와 함께면 교집합.
  // 자기 BP 를 따로 만들어 앞 시나리오의 건수에 섞이지 않게 한다.
  describe('점포 범위 — storeTypes · storeIds (상단 점포 범위 연동)', () => {
    let scopeBpId: number;
    let scopeBmId: number;
    const store: Record<
      | 'direct'
      | 'directNotOperating'
      | 'directClosed'
      | 'franchise'
      | 'franchiseClosed',
      number
    > = {
      direct: 0,
      directNotOperating: 0,
      directClosed: 0,
      franchise: 0,
      franchiseClosed: 0,
    };
    const ownStaff: number[] = [];
    let consentedAccountId: number;
    let consentedStaffId: number; // 가맹 점포(운영)의 본사 제공 동의한 직원
    const consentedName = `범위동의${n}`;

    beforeAll(async () => {
      ({ bpCodeId: scopeBpId } = await prisma.bpCode.create({
        data: {
          // bp_code · store_code CHECK 는 6자리다 — n + offset 이 1_000_000 을 넘어 작은 수로 돌면 6자리로 채운다.
          bpCode: `BP${String((n + 10) % 1_000_000).padStart(6, '0')}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: '점포 범위 BP',
        },
      }));
      const make = async (
        offset: number,
        storeTypeCode: 'DIRECT' | 'FRANCHISE',
        storeStatusCode: 'NOT_OPERATING' | 'OPERATING' | 'CLOSED',
      ) =>
        (
          await prisma.store.create({
            data: {
              storeCode: `ST${String((n + offset) % 1_000_000).padStart(6, '0')}`,
              bpCodeId: scopeBpId,
              storeTypeCode,
              name: `범위 ${storeTypeCode} ${storeStatusCode}`,
              storeStatusCode,
            },
          })
        ).storeId;
      store.direct = await make(10, 'DIRECT', 'OPERATING');
      store.directClosed = await make(11, 'DIRECT', 'CLOSED');
      store.franchise = await make(12, 'FRANCHISE', 'OPERATING');
      store.franchiseClosed = await make(13, 'FRANCHISE', 'CLOSED');
      // 미운영은 폐점이 아니라 점포 유형으로 걸러도 남는다(TO-DO 목록과 같다)
      store.directNotOperating = await make(14, 'DIRECT', 'NOT_OPERATING');
      ({ adminAccountId: scopeBmId } = await prisma.adminAccount.create({
        data: {
          loginId: `listscopebm${n}`,
          bpCodeId: scopeBpId,
          passwordHash: '!',
          roleTypeCode: 'BM',
          roleGroupId: (
            await prisma.roleGroup.findFirstOrThrow({
              where: { roleCode: 'BM000001' },
            })
          ).roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      }));
      for (const storeId of Object.values(store)) {
        const s = await prisma.staffMember.create({
          data: {
            storeId,
            name: `범위직원${storeId}`,
            phone: `010${randomInt(10_000_000, 99_999_999)}`,
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            joinStatus: 'JOINED',
          },
        });
        ownStaff.push(s.staffMemberId);
      }
      // 본사 제공 동의는 계정에 있다 — 동의한 계정에 묶은 가맹 점포 직원 한 명을 더한다
      const phone = `010${randomInt(10_000_000, 99_999_999)}`;
      ({ accountId: consentedAccountId } = await prisma.account.create({
        data: {
          email: `scope-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '범위동의계정',
          birthDate: new Date('1990-01-01'),
          phone,
          status: 'JOINED',
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date(),
        },
      }));
      ({ staffMemberId: consentedStaffId } = await prisma.staffMember.create({
        data: {
          storeId: store.franchise,
          name: consentedName,
          phone,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
          accountId: consentedAccountId,
        },
      }));
      ownStaff.push(consentedStaffId);
    });

    afterAll(async () => {
      await prisma.staffMember.deleteMany({
        where: { staffMemberId: { in: ownStaff } },
      });
      await prisma.account.deleteMany({
        where: { accountId: consentedAccountId },
      });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: scopeBmId },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: scopeBmId },
      });
      await prisma.store.deleteMany({
        where: { storeId: { in: Object.values(store) } },
      });
      await prisma.bpCode.deleteMany({ where: { bpCodeId: scopeBpId } });
    });

    /** 나온 줄의 점포(겹치면 하나로) — 가맹 점포 줄은 BP 마스터에게 가린 행이라 직원 ID 가 없어 점포로 본다 */
    const storesOf = async (query: string) => {
      const res = await get(`?pageSize=200&${query}`, scopeBmId);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(res.body.items.length);
      return [...new Set(res.body.items.map((i) => i.store.storeId))].sort(
        (a, b) => a - b,
      );
    };
    const sorted = (...list: number[]) => [...list].sort((a, b) => a - b);

    it('점포 유형을 주지 않으면 유형 · 폐점 무관 — 폐점 점포 직원도 나온다', async () => {
      expect(await storesOf('')).toEqual(sorted(...Object.values(store)));
    });

    it('직영만 — 폐점 직영만 빠지고 미운영 직영은 남는다', async () => {
      expect(await storesOf('storeTypes=DIRECT')).toEqual(
        sorted(store.direct, store.directNotOperating),
      );
    });

    it('가맹만 — 폐점 가맹은 빠진다', async () => {
      expect(await storesOf('storeTypes=FRANCHISE')).toEqual([store.franchise]);
    });

    it.each([
      'storeTypes=DIRECT,FRANCHISE',
      'storeTypes=DIRECT&storeTypes=FRANCHISE',
    ])('둘 다(%s) — 폐점 점포만 빠진다', async (query) => {
      expect(await storesOf(query)).toEqual(
        sorted(store.direct, store.directNotOperating, store.franchise),
      );
    });

    it('storeIds 와 함께면 교집합 — 고른 점포 중 그 유형 · 폐점 아닌 것만', async () => {
      const all = Object.values(store).join(',');
      expect(await storesOf(`storeIds=${all}&storeTypes=DIRECT`)).toEqual(
        sorted(store.direct, store.directNotOperating),
      );
      expect(
        await storesOf(`storeIds=${store.direct}&storeTypes=FRANCHISE`),
      ).toEqual([]);
    });

    it('폐점 점포는 storeIds 로 고르면 나온다(점포 유형 없이)', async () => {
      expect(await storesOf(`storeIds=${store.directClosed}`)).toEqual([
        store.directClosed,
      ]);
      // 같은 점포를 점포 유형과 함께 고르면 빠진다
      expect(
        await storesOf(`storeIds=${store.directClosed}&storeTypes=DIRECT`),
      ).toEqual([]);
    });

    it('관리 범위 밖 id 는 조용히 빠진다 — 범위 안 id 만 남는다', async () => {
      expect(
        await storesOf(
          `storeIds=${store.direct},${otherBpStoreId},${directStoreId}`,
        ),
      ).toEqual([store.direct]);
      expect(
        await storesOf(`storeIds=${otherBpStoreId}&storeTypes=DIRECT`),
      ).toEqual([]);
    });

    it('storeIds 는 쉼표로 1000개까지 받고 1001개는 400', async () => {
      // 범위 안 점포 하나 + 없는 id 999개 — 없는 id 는 범위 밖처럼 빠진다
      const filler = Array.from({ length: 999 }, (_, i) => 2_000_000_000 + i);
      const ids1000 = [store.direct, ...filler].join(',');
      expect(await storesOf(`storeIds=${ids1000}`)).toEqual([store.direct]);
      const res = await get(`?storeIds=${ids1000},${2_100_000_000}`, scopeBmId);
      expect(res.status).toBe(400);
    });

    it('반복과 쉼표를 섞어도 받는다', async () => {
      expect(
        await storesOf(
          `storeIds=${store.direct},${store.franchise}&storeIds=${store.directClosed}`,
        ),
      ).toEqual(sorted(store.direct, store.franchise, store.directClosed));
    });

    it('점포 유형으로 걸러도 가림은 그대로 — 동의 안 한 가맹 직원은 가린 줄, 동의한 직원은 보인다', async () => {
      const res = await get('?pageSize=200&storeTypes=FRANCHISE', scopeBmId);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            staffMemberId: null,
            isMasked: true,
            name: null,
            phone: null,
          }),
          expect.objectContaining({
            staffMemberId: consentedStaffId,
            isMasked: false,
            name: consentedName,
          }),
        ]),
      );
    });

    it('점포 유형 + 검색이면 동의 안 한 가맹 직원은 빠지고 total 도 그 수다', async () => {
      // 두 직원 이름 모두 「범위」로 시작한다 — 개인 칸으로 거르면 가린 직원은 결과 · 건수에서 빠진다
      const res = await get(
        `?pageSize=200&storeTypes=FRANCHISE&keyword=${encodeURIComponent('범위')}`,
        scopeBmId,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items.map((i) => i.staffMemberId)).toEqual([
        consentedStaffId,
      ]);
    });

    it.each([
      'storeTypes=',
      'storeTypes=HQ',
      'storeTypes=DIRECT,',
      'storeTypes=direct',
    ])('점포 유형 형식 오류는 400 — %s', async (query) => {
      expect((await get(`?${query}`, scopeBmId)).status).toBe(400);
    });
  });
});
