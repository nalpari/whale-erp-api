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
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';

// 관리자 웹 출·퇴근 현황 조회를 실제 DB 로 확인한다(WHALEERP-217 · 219) — 메뉴 권한 · 업무 범위 밖 점포 빠짐, 하루 · 기간 조회, 짝 퇴근,
// 상태 판정, 본사 계정에게 동의 없는 가맹 직원은 줄째로 빠지고 건수에만 들어가는 것(ATT-30).
describe('출·퇴근 현황 조회 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const today = kstToday();
  const yesterday = addDays(today, -1);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  /** 한국 시각 그날 hh:mm */
  const at = (day: Date, hh: number, mm = 0) =>
    new Date(kstDayStart(day).getTime() + (hh * 60 + mm) * 60_000);

  let bpCodeId: number;
  let otherBpCodeId: number;
  let bmId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let otherStoreId: number;
  let directStaffId: number;
  let hiddenStaffId: number;
  let sharedStaffId: number;
  let staffAccountId: number;
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
    const bp = (offset: number) =>
      prisma.bpCode.create({
        data: {
          bpCode: `BP${(n + offset) % 1_000_000}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: '출퇴근 현황 BP',
        },
      });
    ({ bpCodeId } = await bp(0));
    ({ bpCodeId: otherBpCodeId } = await bp(1));
    const store = (offset: number, owner: number, storeTypeCode: string) =>
      prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId: owner,
          storeTypeCode,
          name: `현황 ${storeTypeCode}`,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ storeId: directStoreId } = await store(0, bpCodeId, 'DIRECT'));
    ({ storeId: franchiseStoreId } = await store(1, bpCodeId, 'FRANCHISE'));
    ({ storeId: otherStoreId } = await store(2, otherBpCodeId, 'DIRECT'));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `attrec${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    directStaffId = await staff(directStoreId, '가직영', false);
    hiddenStaffId = await staff(franchiseStoreId, '나가맹', false);
    sharedStaffId = await staff(franchiseStoreId, '다가맹동의', true);
    staffAccountId = (
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: directStaffId },
      })
    ).accountId!;

    // 어제: 직영 09:00 예정 · 09:05 출근 · 18:00 퇴근(지각), 가맹 둘은 출근만(퇴근 미등록)
    await prisma.workSchedule.create({
      data: {
        staffMemberId: directStaffId,
        storeId: directStoreId,
        startAt: at(yesterday, 9),
        endAt: at(yesterday, 18),
        breakMinutes: 60,
        createdBy: bmId,
      },
    });
    const inRec = await punch(
      directStaffId,
      directStoreId,
      'CHECK_IN',
      at(yesterday, 9, 5),
    );
    await punch(
      directStaffId,
      directStoreId,
      'CHECK_OUT',
      at(yesterday, 18),
      inRec,
      'OUT_OF_RADIUS_CHECKOUT',
    );
    await punch(hiddenStaffId, franchiseStoreId, 'CHECK_IN', at(yesterday, 10));
    await punch(sharedStaffId, franchiseStoreId, 'CHECK_IN', at(yesterday, 11));
  });

  async function staff(storeId: number, name: string, consented: boolean) {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `attrec-${n}@test.invalid`,
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
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'PAPER',
        startDate: addDays(today, -30),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'SIGNED',
        createdBy: bmId,
      },
    });
    return staffMemberId;
  }

  async function punch(
    staffMemberId: number,
    storeId: number,
    kind: 'CHECK_IN' | 'CHECK_OUT',
    recordedAt: Date,
    checkIn?: number,
    reviewReason?: 'OUT_OF_RADIUS_CHECKOUT',
  ) {
    const r = await prisma.attendanceRecord.create({
      data: {
        staffMemberId,
        storeId,
        kind,
        recordedAt,
        receivedAt: recordedAt,
        checkInAttendanceRecordId: checkIn ?? null,
        reviewReason: reviewReason ?? null,
      },
    });
    return r.attendanceRecordId;
  }

  afterAll(async () => {
    if (!prisma) return;
    const records = { staffMemberId: { in: staffIds } };
    await prisma.attendanceCorrection.deleteMany({
      where: { attendanceRecord: records },
    });
    await prisma.attendanceRecord.deleteMany({
      where: { ...records, kind: 'CHECK_OUT' },
    });
    await prisma.attendanceRecord.deleteMany({ where: records });
    await prisma.workSchedule.deleteMany({ where: records });
    await prisma.contract.deleteMany({ where: records });
    await prisma.staffMember.deleteMany({ where: records });
    const accounts = { accountId: { in: accountIds } };
    await prisma.authSession.deleteMany({ where: accounts });
    await prisma.locationConsent.deleteMany({ where: accounts });
    await prisma.account.deleteMany({ where: accounts });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.store.deleteMany({
      where: {
        storeId: { in: [directStoreId, franchiseStoreId, otherStoreId] },
      },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpCodeId] } },
    });
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
  const get = async (path: string, status: number) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .expect(status);

  type Row = {
    staffMemberId: number;
    date?: string;
    status: string | null;
    pairs: {
      checkIn: { time: string } | null;
      checkOut: { time: string; reviewReason: string | null } | null;
    }[];
    schedules: { startTime: string; endTime: string }[];
  };

  it('하루 — 예정 · 출근 · 짝 퇴근 · 사유 · 상태(첫 출근이 시작보다 늦으면 지각)', async () => {
    const res = await get(
      `/attendance-records/daily?storeIds=${directStoreId}&date=${ymd(yesterday)}`,
      200,
    );
    const row = (res.body as { items: Row[] }).items.find(
      (r) => r.staffMemberId === directStaffId,
    )!;
    expect(row.schedules).toEqual([
      expect.objectContaining({ startTime: '09:00', endTime: '18:00' }),
    ]);
    expect(row.pairs).toEqual([
      {
        checkIn: expect.objectContaining({ time: '09:05' }) as unknown,
        checkOut: expect.objectContaining({
          time: '18:00',
          reviewReason: 'OUT_OF_RADIUS_CHECKOUT',
        }) as unknown,
      },
    ]);
    expect(row.status).toBe('LATE');
  });

  it('하루 — 본사 계정에게 동의 없는 가맹 직원은 줄이 없고 건수에만 든다(ATT-30)', async () => {
    const res = await get(
      `/attendance-records/daily?storeIds=${franchiseStoreId}&date=${ymd(yesterday)}`,
      200,
    );
    const body = res.body as { items: Row[]; counts: Record<string, number> };
    expect(body.items.map((r) => r.staffMemberId)).toEqual([sharedStaffId]);
    // 어제 퇴근 없는 출근 둘 — 보이는 하나와 가린 하나. 근무스케줄이 없는 어제라 아직 퇴근을 기다려(밤샘 근무) 퇴근 미등록이 아니다
    expect(body.counts.NORMAL).toBe(2);
    expect(body.counts.MISSING_CHECK_OUT).toBe(0);
  });

  it('기간 — 기록 · 근무스케줄이 있는 날만, 직원을 고르면 그 직원만', async () => {
    const res = await get(
      `/attendance-records?storeIds=${directStoreId}&from=${ymd(addDays(today, -7))}&to=${ymd(today)}&staffMemberId=${directStaffId}`,
      200,
    );
    const items = (res.body as { items: Row[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      staffMemberId: directStaffId,
      date: ymd(yesterday),
      status: 'LATE',
    });
    // 한 주가 아니면 근태 요약 값이 없다
    expect(res.body).not.toHaveProperty('weekStaff');
  });

  it('기간이 월~일 한 주면 직원별 근태 요약 — 급여 계산과 같은 규칙(근무는 휴게를 뺀다)', async () => {
    const back = (yesterday.getUTCDay() + 6) % 7;
    const monday = addDays(yesterday, -back);
    const res = await get(
      `/attendance-records?storeIds=${directStoreId}&from=${ymd(monday)}&to=${ymd(addDays(monday, 6))}&staffMemberId=${directStaffId}`,
      200,
    );
    // 어제 09:05 ~ 18:00 = 535분, 근무스케줄 휴게 60분을 뺀다
    expect(
      (
        res.body as {
          weekStaff: {
            staffMemberId: number;
            workedMinutes: number;
            isWeeklyHolidayEligible: boolean;
          }[];
        }
      ).weekStaff,
    ).toEqual([
      expect.objectContaining({
        staffMemberId: directStaffId,
        workedMinutes: 475,
        // 계약 근무 요일이 없는 계약(1주 소정 0시간) — 주휴 대상 아님
        isWeeklyHolidayEligible: false,
      }),
    ]);
  });

  it('기간 — 가려지는 직원 · 다른 점포 직원을 고르면 404, 92일을 넘으면 400', async () => {
    await get(
      `/attendance-records?storeIds=${franchiseStoreId}&from=${ymd(yesterday)}&to=${ymd(today)}&staffMemberId=${hiddenStaffId}`,
      404,
    );
    await get(
      `/attendance-records?storeIds=${franchiseStoreId}&from=${ymd(yesterday)}&to=${ymd(today)}&staffMemberId=${directStaffId}`,
      404,
    );
    await get(
      `/attendance-records?storeIds=${directStoreId}&from=${ymd(addDays(today, -92))}&to=${ymd(today)}`,
      400,
    );
  });

  it('업무 범위 밖 점포는 빠진다(빈 목록) · 점포 유형 범위는 그 유형만 · 직원 앱 토큰은 403', async () => {
    const outside = await get(
      `/attendance-records/daily?storeIds=${otherStoreId}&date=${ymd(yesterday)}`,
      200,
    );
    expect((outside.body as { items: Row[] }).items).toEqual([]);
    const direct = await get(
      `/attendance-records/daily?storeTypes=DIRECT&date=${ymd(yesterday)}`,
      200,
    );
    const ids = (direct.body as { items: Row[] }).items.map(
      (r) => r.staffMemberId,
    );
    expect(ids).toContain(directStaffId);
    expect(ids).not.toContain(sharedStaffId);
    const session = await app.get(AuthSessionService).issue({
      accountId: staffAccountId,
      deviceIdentifier: `attrec-${staffAccountId}`,
    });
    const token = await app.get(JwtService).signAsync({
      sub: staffAccountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
    await request(app.getHttpServer())
      .get(
        `/attendance-records/daily?storeIds=${directStoreId}&date=${ymd(today)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  const post = async (path: string, body: object, status: number) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send(body)
      .expect(status);

  describe('보정 · 이상 없음 · 대신 등록 · 이력 (WHALEERP-218)', () => {
    it('보정 — 화면이 본 값과 같으면 고치고 이력 · 사유 지움, 그사이 바뀌었으면 409', async () => {
      const checkIn = await prisma.attendanceRecord.findFirstOrThrow({
        where: { staffMemberId: directStaffId, kind: 'CHECK_IN' },
      });
      const checkOut = await prisma.attendanceRecord.findFirstOrThrow({
        where: { checkInAttendanceRecordId: checkIn.attendanceRecordId },
      });
      await post(
        `/attendance-records/${checkIn.attendanceRecordId}/correction`,
        {
          checkInTime: '09:05',
          checkOutTime: '18:30',
          reason: '퇴근 시각 정정',
          expectedCheckInAt: checkIn.recordedAt.toISOString(),
          expectedCheckOutAt: new Date(0).toISOString(),
        },
        409,
      );
      const res = await post(
        `/attendance-records/${checkOut.attendanceRecordId}/correction`,
        {
          checkInTime: '09:05',
          checkOutTime: '18:30',
          reason: '퇴근 시각 정정',
          expectedCheckInAt: checkIn.recordedAt.toISOString(),
          expectedCheckOutAt: checkOut.recordedAt.toISOString(),
        },
        200,
      );
      expect(res.body).toEqual({ isPayslipConfirmed: false });
      const after = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { attendanceRecordId: checkOut.attendanceRecordId },
      });
      expect(after.recordedAt).toEqual(at(yesterday, 18, 30));
      expect(after.reviewReason).toBeNull();
      expect(after.reviewedBy).toBe(bmId);
      const history = await get(
        `/attendance-records/${checkIn.attendanceRecordId}/history`,
        200,
      );
      expect((history.body as { items: unknown[] }).items).toEqual([
        expect.objectContaining({
          kind: 'CORRECTION',
          before: '출근 09:05 · 퇴근 18:00',
          after: '출근 09:05 · 퇴근 18:30',
          reason: '퇴근 시각 정정',
        }),
      ]);
    });

    it('보정 — 퇴근 미등록 짝에 퇴근을 넣으면 짝 퇴근이 생기고, 대신 등록이 아니라 보정 한 건이다(2026-10-26)', async () => {
      const checkIn = await prisma.attendanceRecord.findFirstOrThrow({
        where: { staffMemberId: sharedStaffId, kind: 'CHECK_IN' },
      });
      await post(
        `/attendance-records/${checkIn.attendanceRecordId}/correction`,
        {
          checkInTime: '11:00',
          checkOutTime: '20:00',
          reason: '퇴근 누락',
          expectedCheckInAt: checkIn.recordedAt.toISOString(),
        },
        200,
      );
      const out = await prisma.attendanceRecord.findFirstOrThrow({
        where: { checkInAttendanceRecordId: checkIn.attendanceRecordId },
      });
      expect(out).toMatchObject({
        kind: 'CHECK_OUT',
        entryMethod: 'SELF',
        proxyBy: null,
        proxyReason: null,
      });
      const history = await get(
        `/attendance-records/${checkIn.attendanceRecordId}/history`,
        200,
      );
      expect(
        (history.body as { items: { kind: string }[] }).items.map(
          (i) => i.kind,
        ),
      ).toEqual(['CORRECTION']);
    });

    it('이상 없음 — 사유만 지운다, 사유가 없으면 409 · 가려진 직원 기록은 404', async () => {
      const r = await prisma.attendanceRecord.create({
        data: {
          staffMemberId: directStaffId,
          storeId: directStoreId,
          kind: 'CHECK_IN',
          recordedAt: at(today, 9),
          receivedAt: at(today, 9),
          reviewReason: 'OUT_OF_RADIUS_CHECKIN',
        },
      });
      await post(`/attendance-records/${r.attendanceRecordId}/review`, {}, 200);
      const after = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { attendanceRecordId: r.attendanceRecordId },
      });
      expect(after).toMatchObject({ reviewReason: null, reviewedBy: bmId });
      expect(after.recordedAt).toEqual(at(today, 9));
      await post(`/attendance-records/${r.attendanceRecordId}/review`, {}, 409);
      const hidden = await prisma.attendanceRecord.findFirstOrThrow({
        where: { staffMemberId: hiddenStaffId },
      });
      await post(
        `/attendance-records/${hidden.attendanceRecordId}/review`,
        {},
        404,
      );
    });

    it('본사 역할에게 가려진 가맹 직원은 이력 · 보정 · 대신 등록 모두 404, 대신 등록 선택지에도 없다(ATT-30, WHALEERP-223)', async () => {
      const hidden = await prisma.attendanceRecord.findFirstOrThrow({
        where: { staffMemberId: hiddenStaffId },
      });
      await get(
        `/attendance-records/${hidden.attendanceRecordId}/history`,
        404,
      );
      await post(
        `/attendance-records/${hidden.attendanceRecordId}/correction`,
        { checkInTime: '10:00', checkOutTime: '18:00', reason: '보정' },
        404,
      );
      await post(
        '/attendance-records/proxy',
        {
          staffMemberId: hiddenStaffId,
          date: ymd(yesterday),
          checkInTime: '09:00',
          checkOutTime: '18:00',
          reason: '대신 등록',
        },
        404,
      );
      const options = await get(
        `/attendance-records/proxy-staff?storeIds=${franchiseStoreId}&date=${ymd(yesterday)}`,
        200,
      );
      expect(
        (options.body as { items: { staffMemberId: number }[] }).items.map(
          (i) => i.staffMemberId,
        ),
      ).not.toContain(hiddenStaffId);
    });

    it('대신 등록 — 위치정보 동의 없는 직원은 대신 등록(isProxy)으로 등록된다 · 3개월 지난 날은 400', async () => {
      const options = await get(
        `/attendance-records/proxy-staff?storeIds=${directStoreId}&date=${ymd(yesterday)}`,
        200,
      );
      expect(
        (
          options.body as {
            items: { staffMemberId: number; isProxy: boolean }[];
          }
        ).items.find((i) => i.staffMemberId === directStaffId),
      ).toMatchObject({ isProxy: true });
      await post(
        '/attendance-records/proxy',
        {
          staffMemberId: directStaffId,
          date: ymd(addDays(today, -2)),
          checkInTime: '22:00',
          checkOutTime: '02:00',
          reason: '위치 수집 일시 중지 · 점장 확인',
        },
        200,
      );
      const proxies = await prisma.attendanceRecord.findMany({
        where: { staffMemberId: directStaffId, entryMethod: 'PROXY' },
        orderBy: { attendanceRecordId: 'asc' },
      });
      expect(proxies.map((p) => [p.kind, p.recordedAt])).toEqual([
        ['CHECK_IN', at(addDays(today, -2), 22)],
        ['CHECK_OUT', at(addDays(today, -1), 2)],
      ]);
      // 기간 조회 줄에 이력이 붙는다 — 보정이 필요한 기록의 「대신 등록 사유 · 처리한 사람」
      const period = await get(
        `/attendance-records?storeIds=${directStoreId}&from=${ymd(addDays(today, -2))}&to=${ymd(addDays(today, -2))}&staffMemberId=${directStaffId}`,
        200,
      );
      const [day] = (
        period.body as {
          items: {
            edits: {
              kind: string;
              by: string;
              byRole: string | null;
              reason: string;
            }[];
          }[];
        }
      ).items;
      const admin = await prisma.adminAccount.findUniqueOrThrow({
        where: { adminAccountId: bmId },
        select: { name: true, loginId: true, roleGroup: true },
      });
      expect(day.edits).toEqual([
        expect.objectContaining({
          kind: 'PROXY',
          by: admin.name ?? admin.loginId,
          byRole: admin.roleGroup.name,
          reason: '위치 수집 일시 중지 · 점장 확인',
        }),
      ]);
      await post(
        '/attendance-records/proxy',
        {
          staffMemberId: directStaffId,
          date: ymd(addDays(today, -100)),
          checkInTime: '09:00',
          reason: '오래된 기록',
        },
        400,
      );
    });

    it('대신 등록 — 같은 직원의 기록과 시간이 겹치면 409 ATTENDANCE_OVERLAP · 아무것도 남지 않는다(다시 누르기 · 두 관리자)', async () => {
      const body = {
        staffMemberId: directStaffId,
        date: ymd(addDays(today, -6)),
        checkInTime: '10:00',
        checkOutTime: '15:00',
        reason: '위치 수집 일시 중지',
      };
      await post('/attendance-records/proxy', body, 200);
      const before = await prisma.attendanceRecord.count({
        where: { staffMemberId: directStaffId },
      });
      const again = await post('/attendance-records/proxy', body, 409);
      expect((again.body as { code: string }).code).toBe('ATTENDANCE_OVERLAP');
      await post(
        '/attendance-records/proxy',
        { ...body, checkInTime: '14:00', checkOutTime: '18:00' },
        409,
      );
      expect(
        await prisma.attendanceRecord.count({
          where: { staffMemberId: directStaffId },
        }),
      ).toBe(before);
      // 겹치지 않으면 같은 날 두 번째 짝도 받는다
      await post(
        '/attendance-records/proxy',
        { ...body, checkInTime: '16:00', checkOutTime: '18:00' },
        200,
      );
    });

    it('대신 등록 — 아직 오지 않은 시각은 400 · 아무것도 남지 않는다(오늘 출근의 다음 날 퇴근)', async () => {
      const before = await prisma.attendanceRecord.count({
        where: { staffMemberId: directStaffId },
      });
      const res = await post(
        '/attendance-records/proxy',
        {
          staffMemberId: directStaffId,
          date: ymd(today),
          checkInTime: '00:00',
          checkOutTime: '00:00',
          reason: '미리 등록',
        },
        400,
      );
      expect((res.body as { message: string }).message).toContain(
        '아직 오지 않은 시각',
      );
      expect(
        await prisma.attendanceRecord.count({
          where: { staffMemberId: directStaffId },
        }),
      ).toBe(before);
    });

    it('위치정보에 동의한 직원은 기록 없는 날만 출근 · 퇴근을 함께 넣어 보정으로 채운다(2026-10-26)', async () => {
      const id = await staff(directStoreId, '마동의', false);
      const { accountId } = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: id },
      });
      const { version } = await prisma.termsVersion.findFirstOrThrow({
        where: { termsTypeCode: 'LOCATION', isActive: true, isDeleted: false },
        orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
      });
      await prisma.locationConsent.create({
        data: { accountId: accountId!, consentVersion: version },
      });
      const day = ymd(addDays(today, -3));
      const options = await get(
        `/attendance-records/proxy-staff?storeIds=${directStoreId}&date=${day}`,
        200,
      );
      expect(
        (
          options.body as {
            items: { staffMemberId: number; isProxy: boolean }[];
          }
        ).items.find((i) => i.staffMemberId === id),
      ).toMatchObject({ isProxy: false });
      const body = {
        staffMemberId: id,
        date: day,
        checkInTime: '09:00',
        reason: '출퇴근 누락 · 점장 확인',
      };
      await post('/attendance-records/proxy', body, 400);
      await post(
        '/attendance-records/proxy',
        { ...body, checkOutTime: '18:00' },
        200,
      );
      const records = await prisma.attendanceRecord.findMany({
        where: { staffMemberId: id },
        orderBy: { attendanceRecordId: 'asc' },
      });
      expect(records.map((r) => [r.kind, r.entryMethod, r.recordedAt])).toEqual(
        [
          ['CHECK_IN', 'SELF', at(addDays(today, -3), 9)],
          ['CHECK_OUT', 'SELF', at(addDays(today, -3), 18)],
        ],
      );
      const history = await get(
        `/attendance-records/${records[0].attendanceRecordId}/history`,
        200,
      );
      expect(
        (history.body as { items: { kind: string; reason: string }[] }).items,
      ).toEqual([
        expect.objectContaining({
          kind: 'CORRECTION',
          reason: '출퇴근 누락 · 점장 확인',
        }),
      ]);
      // 그날 기록이 생겼으니 다시 넣으면 그 줄을 보정하라고 409
      const again = await post(
        '/attendance-records/proxy',
        { ...body, checkOutTime: '18:00' },
        409,
      );
      expect((again.body as { code: string }).code).toBe('ATTENDANCE_EXISTS');
    });

    it('대신 등록 — 그날 체결 완료 계약이 없거나 퇴직일 뒤면 422 NO_CONTRACT · 아무것도 남기지 않는다', async () => {
      const before = await prisma.attendanceRecord.count({
        where: { staffMemberId: directStaffId },
      });
      const body = {
        staffMemberId: directStaffId,
        checkInTime: '09:00',
        checkOutTime: '18:00',
        reason: '계약 밖',
      };
      // 계약은 30일 전부터 — 그 앞날은 계약 기간 밖
      const outside = await post(
        '/attendance-records/proxy',
        { ...body, date: ymd(addDays(today, -40)) },
        422,
      );
      expect((outside.body as { code: string }).code).toBe('NO_CONTRACT');
      await prisma.staffMember.update({
        where: { staffMemberId: directStaffId },
        data: { retiredDate: addDays(today, -5) },
      });
      try {
        const retired = await post(
          '/attendance-records/proxy',
          { ...body, date: ymd(addDays(today, -4)) },
          422,
        );
        expect((retired.body as { code: string }).code).toBe('NO_CONTRACT');
      } finally {
        await prisma.staffMember.update({
          where: { staffMemberId: directStaffId },
          data: { retiredDate: null },
        });
      }
      expect(
        await prisma.attendanceRecord.count({
          where: { staffMemberId: directStaffId },
        }),
      ).toBe(before);
    });

    it('대신 등록 — 열린 출근이 범위 밖 근무지에 있으면 409 이고 보정을 권하지 않는다(ATT-35)', async () => {
      const id = await staff(directStoreId, '라겸직', false);
      const { accountId } = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: id },
      });
      const { staffMemberId: elsewhere } = await prisma.staffMember.create({
        data: {
          storeId: otherStoreId,
          accountId,
          name: '라겸직',
          phone: '01000000000',
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
        },
      });
      staffIds.push(elsewhere);
      // 다른 근무지도 체결 완료 소속이어야 열린 출근으로 친다(직원 앱과 같은 ACTIVE_STAFF)
      await prisma.contract.create({
        data: {
          staffMemberId: elsewhere,
          storeId: otherStoreId,
          employmentType: 'PART_TIME',
          contractMethod: 'PAPER',
          startDate: addDays(today, -30),
          isHealthPensionInsured: false,
          isEmploymentInjuryInsured: false,
          status: 'SIGNED',
          createdBy: bmId,
        },
      });
      await punch(elsewhere, otherStoreId, 'CHECK_IN', at(yesterday, 8));
      const res = await post(
        '/attendance-records/proxy',
        {
          staffMemberId: id,
          date: ymd(yesterday),
          checkInTime: '09:00',
          reason: '대신 등록',
        },
        409,
      );
      expect((res.body as { message: string }).message).toBe(
        '이 직원은 다른 근무지에 퇴근하지 않은 출근이 있어 대신 등록할 수 없습니다. 그 근무지에서 퇴근이 등록된 뒤 다시 해 주세요',
      );
    });
  });
});
