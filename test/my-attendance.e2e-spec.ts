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
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 직원 앱 출퇴근 등록을 실제 DB 로 확인한다(WHALEERP-210 · 211 · 212) — 계정 행 잠금으로 동시 출근 · 퇴근 중 하나만 남는지,
// 열린 출근이 계정의 모든 소속에서 하나인지, 확인자료(수집 · 이용) 두 줄, 위치를 보지 않는 근무지, 일시 중지 403, 서명 대기
// 422(ATT-12), 관리자 토큰 403.
describe('직원 앱 출퇴근 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const today = kstToday();

  let bpCodeId: number;
  let bmId: number;
  let gpsStoreId: number;
  let plainStoreId: number;
  let accountId: number;
  let gpsStaffId: number;
  let plainStaffId: number;
  let pendingStaffId: number;
  let pendingContractId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];

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
        tradeName: '출퇴근 BP',
      },
    }));
    const store = (offset: number, isLocationApplied: boolean) =>
      prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name: isLocationApplied ? '출퇴근 강남점' : '출퇴근 역삼점',
          storeStatusCode: 'OPERATING',
          latitude: isLocationApplied ? '37.498095' : null,
          longitude: isLocationApplied ? '127.027610' : null,
          isLocationApplied,
        },
      });
    ({ storeId: gpsStoreId } = await store(0, true));
    ({ storeId: plainStoreId } = await store(1, false));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `att${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    accountId = await account('두근무지');
    // 한 계정이 두 점포에 — 열린 출근은 계정에 하나다
    gpsStaffId = await staff(gpsStoreId, accountId);
    plainStaffId = await staff(plainStoreId, accountId);
    const { version } = await prisma.termsVersion.findFirstOrThrow({
      where: { termsTypeCode: 'LOCATION', isActive: true, isDeleted: false },
      orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
    });
    await prisma.locationConsent.create({
      data: { accountId, consentVersion: version },
    });

    // 계약이 어제 끝났고 재계약이 서명 대기 — 오늘 출근은 422 CONTRACT_PENDING_SIGNATURE
    const pendingAccount = await account('서명대기');
    pendingStaffId = await staff(gpsStoreId, pendingAccount, -1);
    await prisma.locationConsent.create({
      data: { accountId: pendingAccount, consentVersion: version },
    });
    ({ contractId: pendingContractId } = await prisma.contract.create({
      data: contractData(pendingStaffId, gpsStoreId, 'PENDING_SIGNATURE', null),
    }));
  });

  async function account(name: string) {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId: id } = await prisma.account.create({
      data: {
        email: `att-${n}@test.invalid`,
        passwordHash: '!',
        realName: name,
        birthDate: new Date('1990-01-01'),
        phone: `010${n}`,
        status: 'JOINED',
      },
    });
    accountIds.push(id);
    return id;
  }

  function contractData(
    staffMemberId: number,
    storeId: number,
    status: 'SIGNED' | 'PENDING_SIGNATURE',
    endOffset: number | null,
  ) {
    return {
      staffMemberId,
      storeId,
      employmentType: 'PART_TIME' as const,
      contractMethod: 'ELECTRONIC' as const,
      startDate: addDays(today, -30),
      endDate: endOffset === null ? null : addDays(today, endOffset),
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: false,
      status,
      createdBy: bmId,
    };
  }

  async function staff(
    storeId: number,
    owner: number,
    endOffset: number | null = null,
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId: owner,
        name: '출퇴근',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'JOINED',
      },
    });
    staffIds.push(staffMemberId);
    await prisma.contract.create({
      data: contractData(staffMemberId, storeId, 'SIGNED', endOffset),
    });
    return staffMemberId;
  }

  afterAll(async () => {
    if (!prisma) return;
    const records = { staffMemberId: { in: staffIds } };
    await prisma.locationAccessLog.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.attendanceCorrection.deleteMany({
      where: { attendanceRecord: { staffMemberId: { in: staffIds } } },
    });
    await prisma.attendanceRecord.deleteMany({
      where: { ...records, kind: 'CHECK_OUT' },
    });
    await prisma.attendanceRecord.deleteMany({ where: records });
    await prisma.contract.deleteMany({ where: records });
    await prisma.staffMember.deleteMany({ where: records });
    const accounts = { accountId: { in: accountIds } };
    await prisma.locationConsentHistory.deleteMany({
      where: { locationConsent: accounts },
    });
    await prisma.locationConsent.deleteMany({ where: accounts });
    await prisma.authSession.deleteMany({ where: accounts });
    await prisma.account.deleteMany({ where: accounts });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.store.deleteMany({
      where: { storeId: { in: [gpsStoreId, plainStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const tokenOf = async (id: number) => {
    const session = await app.get(AuthSessionService).issue({
      accountId: id,
      deviceIdentifier: `att-e2e-${id}`,
    });
    return app.get(JwtService).signAsync({
      sub: id,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
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
  const post = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .post(`/me/attendance/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  /** 버튼을 눌러 위치를 읽었다 — 확인자료를 남기고 받은 locationReadId */
  const readOf = async (token: string, staffMemberId: number) =>
    (
      (await post('location-reads', token, { staffMemberId }).expect(201))
        .body as { locationReadId: number }
    ).locationReadId;

  it('관리자 토큰은 403', async () => {
    await request(app.getHttpServer())
      .get(`/me/attendance?staffMemberId=${gpsStaffId}`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .expect(403);
  });

  it('출퇴근 화면 — 좌표 · 반경 100m, 동의, 막는 까닭 없음, 열린 출근 없음', async () => {
    const res = await request(app.getHttpServer())
      .get(`/me/attendance?staffMemberId=${gpsStaffId}`)
      .set('Authorization', `Bearer ${await tokenOf(accountId)}`)
      .expect(200);
    expect(res.body).toMatchObject({
      staffMemberId: gpsStaffId,
      store: {
        storeId: gpsStoreId,
        latitude: 37.498095,
        longitude: 127.02761,
        radiusMeters: 100,
        isLocationApplied: true,
      },
      locationConsent: { state: 'AGREED', needsReconsent: false },
      checkInBlock: null,
      openCheckIn: null,
      todaySchedules: [],
    });
  });

  it('출근에 위치 조작 감지는 받지 않는다(앱이 막는다) — 400', async () => {
    await post('check-in', await tokenOf(accountId), {
      staffMemberId: gpsStaffId,
      reviewReason: 'MOCK_LOCATION',
    }).expect(400);
  });

  it('좌표 · 오차 · 반경 안밖은 받지 않는다 — 본문에 오면 400 이고 기록이 생기지 않는다(ATT-05 · ATT-19, WHALEERP-216)', async () => {
    const token = await tokenOf(accountId);
    for (const extra of [
      { latitude: 37.5, longitude: 127.0 },
      { accuracy: 12 },
      { distanceMeters: 30, inRange: true },
    ])
      await post('check-in', token, {
        staffMemberId: gpsStaffId,
        ...extra,
      }).expect(400);
    expect(
      await prisma.attendanceRecord.count({
        where: { staffMemberId: gpsStaffId },
      }),
    ).toBe(0);
  });

  it('위치를 보는 근무지는 위치 읽음 없이 출근할 수 없다 — 400 (ATT-22)', async () => {
    await post('check-in', await tokenOf(accountId), {
      staffMemberId: gpsStaffId,
    }).expect(400);
  });

  it('동시 출근 다섯 — 하나만 201, 나머지는 409 ALREADY_CHECKED_IN. 기록 하나에 확인자료 수집 · 이용이 이어지고, 실패한 등록의 위치 읽음도 남는다', async () => {
    const token = await tokenOf(accountId);
    const before = await prisma.locationAccessLog.count({
      where: { accountId },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, async () =>
        post('check-in', token, {
          staffMemberId: gpsStaffId,
          reviewReason: 'OUT_OF_RADIUS_CHECKIN',
          locationReadId: await readOf(token, gpsStaffId),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409,
    ]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body).toMatchObject({
      code: 'ALREADY_CHECKED_IN',
      openCheckIn: { staffMemberId: gpsStaffId, storeName: '출퇴근 강남점' },
    });
    const rows = await prisma.attendanceRecord.findMany({
      where: { staffMemberId: gpsStaffId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'CHECK_IN',
      reviewReason: 'OUT_OF_RADIUS_CHECKIN',
      entryMethod: 'SELF',
    });
    expect(rows[0].recordedAt).toEqual(rows[0].receivedAt);
    const logs = await prisma.locationAccessLog.findMany({
      where: { attendanceRecordId: rows[0].attendanceRecordId },
      orderBy: { locationAccessLogId: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual(['COLLECT', 'USE']);
    expect(logs[0].occurredAt).toEqual(logs[1].occurredAt);
    expect(await prisma.locationAccessLog.count({ where: { accountId } })).toBe(
      before + 10,
    );
    // 쓴 위치 읽음은 다시 쓸 수 없다
    await post('check-out', token, {
      staffMemberId: gpsStaffId,
      locationReadId: logs[0].locationAccessLogId,
    }).expect(400);
  });

  it('다른 소속에 열린 출근이 있으면 출근 409 · 그 소속으로 퇴근 409 — 열린 출근은 계정에 하나', async () => {
    const token = await tokenOf(accountId);
    const checkIn = await post('check-in', token, {
      staffMemberId: plainStaffId,
    }).expect(409);
    expect(checkIn.body).toMatchObject({
      code: 'ALREADY_CHECKED_IN',
      openCheckIn: { staffMemberId: gpsStaffId },
    });
    const checkOut = await post('check-out', token, {
      staffMemberId: plainStaffId,
    }).expect(409);
    expect(checkOut.body).toMatchObject({
      code: 'NO_OPEN_CHECK_IN',
      openCheckIn: { staffMemberId: gpsStaffId },
    });
  });

  it('일시 중지면 출퇴근 모두 403 LOCATION_PAUSED', async () => {
    const token = await tokenOf(accountId);
    await prisma.locationConsent.updateMany({
      where: { accountId, withdrawnAt: null },
      data: { pausedAt: new Date() },
    });
    try {
      const res = await post('check-out', token, {
        staffMemberId: gpsStaffId,
      }).expect(403);
      expect(res.body).toMatchObject({ code: 'LOCATION_PAUSED' });
      await post('location-reads', token, {
        staffMemberId: gpsStaffId,
      }).expect(403);
    } finally {
      await prisma.locationConsent.updateMany({
        where: { accountId, withdrawnAt: null },
        data: { pausedAt: null },
      });
    }
  });

  it('출근한 다음 날이 지난 열린 출근은 퇴근 409 CHECK_OUT_EXPIRED — 며칠이 하루 근무로 급여에 들어가지 않게', async () => {
    const token = await tokenOf(accountId);
    const open = await prisma.attendanceRecord.findFirstOrThrow({
      where: {
        staffMemberId: gpsStaffId,
        kind: 'CHECK_IN',
        attendanceRecordsAsCheckIn: { none: {} },
      },
    });
    const stale = new Date(open.recordedAt.getTime() - 2 * 24 * 60 * 60_000);
    await prisma.attendanceRecord.update({
      where: { attendanceRecordId: open.attendanceRecordId },
      data: { recordedAt: stale },
    });
    try {
      // 화면도 기한이 지났다고 알린다 — 앱은 퇴근 버튼 대신 관리자 보정 안내를 보인다
      const screen = await request(app.getHttpServer())
        .get(`/me/attendance?staffMemberId=${gpsStaffId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(screen.body).toMatchObject({
        openCheckIn: {
          attendanceRecordId: open.attendanceRecordId,
          isCheckOutExpired: true,
        },
      });
      const res = await post('check-out', token, {
        staffMemberId: gpsStaffId,
        locationReadId: await readOf(token, gpsStaffId),
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'CHECK_OUT_EXPIRED',
        openCheckIn: {
          attendanceRecordId: open.attendanceRecordId,
          isCheckOutExpired: true,
        },
      });
      expect(
        await prisma.attendanceRecord.count({
          where: { checkInAttendanceRecordId: open.attendanceRecordId },
        }),
      ).toBe(0);
    } finally {
      await prisma.attendanceRecord.update({
        where: { attendanceRecordId: open.attendanceRecordId },
        data: { recordedAt: open.recordedAt },
      });
    }
  });

  it('동시 퇴근 셋 — 하나만 201 이고 열린 출근에 짝이 지어진다', async () => {
    const token = await tokenOf(accountId);
    const results = await Promise.all(
      Array.from({ length: 3 }, async () =>
        post('check-out', token, {
          staffMemberId: gpsStaffId,
          reviewReason: 'OUT_OF_RADIUS_CHECKOUT',
          locationReadId: await readOf(token, gpsStaffId),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const done = results.find((r) => r.status === 201)!;
    expect(done.body).toMatchObject({
      kind: 'CHECK_OUT',
      reviewReason: 'OUT_OF_RADIUS_CHECKOUT',
    });
    const [checkIn, checkOut] = await prisma.attendanceRecord.findMany({
      where: { staffMemberId: gpsStaffId },
      orderBy: { attendanceRecordId: 'asc' },
    });
    expect(checkOut.checkInAttendanceRecordId).toBe(checkIn.attendanceRecordId);
  });

  it('출근부터 12시간이 넘은 퇴근에는 확인 필요 「근무 12시간 초과」 LONG_SHIFT 가 붙는다(2026-10-27 재영)', async () => {
    const token = await tokenOf(accountId);
    const { attendanceRecordId } = await prisma.attendanceRecord.create({
      data: {
        staffMemberId: gpsStaffId,
        storeId: gpsStoreId,
        kind: 'CHECK_IN',
        recordedAt: new Date(Date.now() - (12 * 60 + 10) * 60_000),
        receivedAt: new Date(),
      },
    });
    const res = await post('check-out', token, {
      staffMemberId: gpsStaffId,
      locationReadId: await readOf(token, gpsStaffId),
    }).expect(201);
    expect(res.body).toMatchObject({
      kind: 'CHECK_OUT',
      reviewReason: 'LONG_SHIFT',
    });
    const out = await prisma.attendanceRecord.findFirstOrThrow({
      where: { checkInAttendanceRecordId: attendanceRecordId },
    });
    expect(out.reviewReason).toBe('LONG_SHIFT');
    // 뒤 테스트의 출퇴근 현황 합계에 이 짝이 들지 않게 지운다
    await prisma.locationAccessLog.updateMany({
      where: { attendanceRecordId: out.attendanceRecordId },
      data: { attendanceRecordId: null },
    });
    await prisma.attendanceRecord.delete({
      where: { attendanceRecordId: out.attendanceRecordId },
    });
    await prisma.attendanceRecord.delete({ where: { attendanceRecordId } });
  });

  it('위치를 보지 않는 근무지는 동의 없이 받고 확인자료를 남기지 않는다 — 사유가 오거나 위치를 읽으면 400', async () => {
    const token = await tokenOf(accountId);
    await post('location-reads', token, {
      staffMemberId: plainStaffId,
    }).expect(400);
    await post('check-in', token, {
      staffMemberId: plainStaffId,
      reviewReason: 'OUT_OF_RADIUS_CHECKIN',
    }).expect(400);
    await prisma.locationConsent.updateMany({
      where: { accountId, withdrawnAt: null },
      data: { withdrawnAt: new Date() },
    });
    const res = await post('check-in', token, {
      staffMemberId: plainStaffId,
    }).expect(201);
    expect(
      await prisma.locationAccessLog.count({
        where: {
          attendanceRecordId: (res.body as { attendanceRecordId: number })
            .attendanceRecordId,
        },
      }),
    ).toBe(0);
    await post('check-out', token, { staffMemberId: plainStaffId }).expect(201);
  });

  it('퇴직한 소속에 남은 열린 출근은 다른 근무지 출근을 막지 않는다 — 직원이 그 소속을 고를 수 없어 닫을 수 없다', async () => {
    const token = await tokenOf(accountId);
    const stale = await prisma.attendanceRecord.create({
      data: {
        staffMemberId: gpsStaffId,
        storeId: gpsStoreId,
        kind: 'CHECK_IN',
        recordedAt: new Date(Date.now() - 5 * 24 * 3600_000),
        receivedAt: new Date(),
      },
    });
    await prisma.staffMember.update({
      where: { staffMemberId: gpsStaffId },
      data: { employmentStatus: 'RETIRED', retiredDate: new Date() },
    });
    try {
      await post('check-in', token, { staffMemberId: plainStaffId }).expect(
        201,
      );
      await post('check-out', token, { staffMemberId: plainStaffId }).expect(
        201,
      );
    } finally {
      await prisma.staffMember.update({
        where: { staffMemberId: gpsStaffId },
        data: { employmentStatus: 'EMPLOYED', retiredDate: null },
      });
      await prisma.attendanceRecord.delete({
        where: { attendanceRecordId: stale.attendanceRecordId },
      });
    }
  });

  it('오늘을 덮는 체결 완료 계약이 없고 서명 대기 계약이 있으면 422 CONTRACT_PENDING_SIGNATURE (ATT-12)', async () => {
    const owner = (
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: pendingStaffId },
      })
    ).accountId!;
    const token = await tokenOf(owner);
    const view = await request(app.getHttpServer())
      .get(`/me/attendance?staffMemberId=${pendingStaffId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((view.body as { checkInBlock: unknown }).checkInBlock).toEqual({
      reason: 'CONTRACT_PENDING_SIGNATURE',
      contractId: pendingContractId,
    });
    const res = await post('check-in', token, {
      staffMemberId: pendingStaffId,
      locationReadId: await readOf(token, pendingStaffId),
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'CONTRACT_PENDING_SIGNATURE',
      contractId: pendingContractId,
    });
  });

  it('남의 소속은 404', async () => {
    const other = accountIds[1];
    await request(app.getHttpServer())
      .get(`/me/attendance?staffMemberId=${gpsStaffId}`)
      .set('Authorization', `Bearer ${await tokenOf(other)}`)
      .expect(404);
  });

  const mondayYmd = (d: Date) =>
    addDays(d, -((d.getUTCDay() + 6) % 7))
      .toISOString()
      .slice(0, 10);

  it('출퇴근 현황 — 내 소속의 기간 기록(날짜순), 대신 등록한 날에는 이력이 붙는다 · 366일 초과 400 · 남의 소속 404', async () => {
    const token = await tokenOf(accountId);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const proxyAt = new Date(
      addDays(today, -1).getTime() - 9 * 3600_000 + 10 * 3600_000,
    );
    await prisma.attendanceRecord.create({
      data: {
        staffMemberId: gpsStaffId,
        storeId: gpsStoreId,
        kind: 'CHECK_IN',
        recordedAt: proxyAt,
        receivedAt: new Date(),
        entryMethod: 'PROXY',
        proxyBy: bmId,
        proxyReason: '위치 수집 일시 중지',
      },
    });
    const res = await request(app.getHttpServer())
      .get(
        `/me/attendance/records?staffMemberId=${gpsStaffId}&from=${ymd(addDays(today, -1))}&to=${ymd(today)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as {
      storeName: string;
      items: { date: string; edits: { kind: string; reason: string }[] }[];
      totals: { workedMinutes: number; overtimeMinutes: number };
      weeks: { monday: string }[];
    };
    expect(body.storeName).toBe('출퇴근 강남점');
    // 근무 · 연장은 급여 계산 값 — 퇴근 없는 출근뿐이라 0, 주는 기간에 걸친 월요일마다
    expect(body.totals).toEqual({ workedMinutes: 0, overtimeMinutes: 0 });
    expect(body.weeks.map((w) => w.monday)).toEqual([
      ...new Set([addDays(today, -1), today].map((d) => mondayYmd(d))),
    ]);
    expect(body.items.map((i) => i.date)).toEqual([
      ymd(addDays(today, -1)),
      ymd(today),
    ]);
    // 이름이 없는 관리자는 로그인 아이디 대신 「관리자」, 권한 그룹은 직원에게 내리지 않는다(WHALEERP-223)
    expect(body.items[0].edits).toEqual([
      expect.objectContaining({
        kind: 'PROXY',
        reason: '위치 수집 일시 중지',
        by: '관리자',
        byRole: null,
      }),
    ]);
    expect(body.items[1].edits).toEqual([]);
    await request(app.getHttpServer())
      .get(
        `/me/attendance/records?staffMemberId=${gpsStaffId}&from=${ymd(addDays(today, -366))}&to=${ymd(today)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(
        `/me/attendance/records?staffMemberId=${gpsStaffId}&from=${ymd(today)}&to=${ymd(today)}`,
      )
      .set('Authorization', `Bearer ${await tokenOf(accountIds[1])}`)
      .expect(404);
  });
});
