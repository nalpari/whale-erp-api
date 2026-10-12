import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { STAFF_JOIN_STATES } from '../src/staff-members/join-state';
import { StaffMemberListResponseDto } from '../src/staff-members/dto/staff-member-list.response.dto';

// 직원 목록(WHALEERP-329)을 실제 DB 로 확인한다. 가입 상태 필터는 초대 · 보류 관계 조건이라 목으로는 Prisma 가
// 그 조건을 맞게 푸는지 증명되지 않는다.
describe('직원 목록 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let otherBpId: number;
  let otherBpStoreId: number;
  let bmId: number; // BP 마스터, 전체 점포
  let fmId: number; // 가맹마스터, 가맹 점포 매핑
  let inactiveId: number; // 미사용 관리자
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
    fmId = await admin(`listfm${n}`, 'FM', 'FM000001', {
      storeMappings: { create: { storeId: franchiseStoreId } },
    });
    inactiveId = await admin(`listoff${n}`, 'BM', 'BM000001', {
      isAllStores: true,
      accountStatusCode: 'INACTIVE',
    });

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

    await staff('franchise', franchiseStoreId, '가맹직원', 'JOINED');
    await staff('otherBp', otherBpStoreId, '다른BP직원', 'JOINED');
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.linkHold.deleteMany({ where: { invitation: byStaff } });
    await prisma.invitation.deleteMany({ where: byStaff });
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
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: {
        storeId: { in: [directStoreId, franchiseStoreId, otherBpStoreId] },
      },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
    await app.close();
  });

  const tokenOf = (sub: number) =>
    app.get(JwtService).signAsync({
      sub,
      type: 'admin',
      email: 'a@test.invalid',
      typ: 'access',
    });
  /** 응답 본문은 any 라 린트(no-unsafe-*)를 지나도록 응답 DTO 모양을 붙여 돌려준다. */
  const get = async (query: string, sub = bmId) => {
    const res = await request(app.getHttpServer())
      .get(`/staff-members${query}`)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return { status: res.status, body: res.body as StaffMemberListResponseDto };
  };
  const idsOf = (body: { items: { staffMemberId: number }[] }) =>
    body.items.map((i) => i.staffMemberId);

  it('관리 범위의 직원만, 최근 등록 먼저 — 다른 BP 는 없다', async () => {
    const res = await get('?pageSize=200');
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).not.toContain(ids.otherBp);
    expect(idsOf(res.body)).toEqual(
      [...staffIds].filter((id) => id !== ids.otherBp).sort((a, b) => b - a),
    );
    expect(res.body.total).toBe(staffIds.length - 1);
  });

  it('BP 마스터에게 가맹 점포 직원은 가린 행이고 total 에 센다', async () => {
    const res = await get('?pageSize=200');
    const row = res.body.items.find((i) => i.staffMemberId === ids.franchise);
    expect(row).toMatchObject({ isMasked: true, name: null, phone: null });
    expect(row?.store).toEqual({
      storeId: franchiseStoreId,
      name: '가맹점',
      storeType: 'FRANCHISE',
    });
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
    const hitsByState = new Map<string, number[]>();
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
    'storeIds=abc',
    'storeIds=3,,5',
    'storeIds=0',
    'storeIds=2147483648',
    'pageSize=201',
    'page=1e20',
    'page=1000001',
    'joinState=NOPE',
    'unknown=1',
  ])('쿼리 형식 오류는 400 — %s', async (query) => {
    expect((await get(`?${query}`)).status).toBe(400);
  });

  it('미사용 관리자는 403', async () => {
    expect((await get('', inactiveId)).status).toBe(403);
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
});
