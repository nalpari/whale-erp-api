import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { kstDayStart } from '../src/staff-members/kst-date';

// 급여명세서 지급 항목 계산을 실제 DB 로 확인한다(WHALEERP-227) — 초안의 기본급 · 주휴수당 · 연장수당이 근로계약 · 출퇴근
// 기록으로 채워지고, 가산 적용을 끄면 다시 계산되고, 「출퇴근으로 다시 계산」이 고친 값을 버리고 검토 사유를 모두 새로 판정하는 것.
// 급여 기간 중 계약이 바뀌면 날마다 그날 계약으로 계산한다(2026-10-26).
//
// 파트타이머 · 시급 10,000 · 월 · 수 · 금 10:00–15:00(휴게 없음, 1주 15시간). 2026-09 의 월 · 수 · 금 13일을 10:00–15:00 에
// 출퇴근하고, 9/9(수)만 17:00 퇴근(+2시간 연장). 주휴는 일요일이 9월인 개근 주 넷(8/31 · 9/7 · 9/14 · 9/21 주).
describe('급여명세서 지급 항목 계산 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let storeId: number;
  let bmId: number;
  let accountId: number;
  let staffMemberId: number;
  let payslipId: number;

  const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
  const at = (ymd: string, hh: number) =>
    new Date(kstDayStart(day(ymd)).getTime() + hh * 60 * 60_000);
  const time = (hh: number) => new Date(Date.UTC(1970, 0, 1, hh));

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

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '급여 계산 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '급여 계산 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `paycalc${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ accountId } = await prisma.account.create({
      data: {
        email: `paycalc-${n}@test.invalid`,
        passwordHash: '!',
        realName: '가계산',
        birthDate: new Date('1990-01-01'),
        phone: `0109${n}`,
        status: 'JOINED',
      },
    }));
    ({ staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '가계산',
        phone: `0109${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'JOINED',
      },
    }));
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'PAPER',
        startDate: day('2026-08-01'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        wageAmount: 10_000,
        weeklyHoliday: 'SUN',
        status: 'SIGNED',
        createdBy: bmId,
        contractWorkDays: {
          create: (['MON', 'WED', 'FRI'] as const).map((weekday) => ({
            weekday,
            startTime: time(10),
            endTime: time(15),
          })),
        },
      },
    });
    for (
      let d = day('2026-08-31');
      d <= day('2026-09-30');
      d = new Date(d.getTime() + 86_400_000)
    ) {
      if (![1, 3, 5].includes(d.getUTCDay())) continue;
      const ymd = d.toISOString().slice(0, 10);
      const { attendanceRecordId } = await prisma.attendanceRecord.create({
        data: {
          staffMemberId,
          storeId,
          kind: 'CHECK_IN',
          recordedAt: at(ymd, 10),
          receivedAt: at(ymd, 10),
        },
      });
      const out = at(ymd, ymd === '2026-09-09' ? 17 : 15);
      await prisma.attendanceRecord.create({
        data: {
          staffMemberId,
          storeId,
          kind: 'CHECK_OUT',
          recordedAt: out,
          receivedAt: out,
          checkInAttendanceRecordId: attendanceRecordId,
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    const mine = { staffMemberId };
    const payslip = { payslip: mine };
    await prisma.payslipLog.deleteMany({ where: payslip });
    await prisma.payslipReviewReason.deleteMany({ where: payslip });
    await prisma.payslipItem.deleteMany({ where: payslip });
    await prisma.payslip.deleteMany({ where: mine });
    await prisma.attendanceRecord.deleteMany({
      where: { ...mine, kind: 'CHECK_OUT' },
    });
    await prisma.attendanceRecord.deleteMany({ where: mine });
    await prisma.contractWorkDay.deleteMany({ where: { contract: mine } });
    await prisma.contract.deleteMany({ where: mine });
    await prisma.staffMember.deleteMany({ where: mine });
    await prisma.account.deleteMany({ where: { accountId } });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const token = async () =>
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
  const send = async (
    method: 'get' | 'post' | 'put',
    path: string,
    status: number,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await token()}`);
    return (body ? req.send(body) : req).expect(status);
  };

  type Detail = {
    updatedAt: string;
    isPremiumApplied: boolean;
    isWithholdingApplied: boolean;
    grossPayAmount: number;
    items: {
      payslipItemMasterId: number;
      itemCode: string;
      calculatedAmount: number | null;
      adjustedAmount: number | null;
      isEntered: boolean;
    }[];
    logs: { summary: string }[];
    reviewReasons: {
      reviewReason: string;
      detail: string | null;
      acknowledgedAt: string | null;
    }[];
  };
  const detail = async () =>
    (await send('get', `/payslips/${payslipId}`, 200)).body as Detail;
  const amounts = (d: Detail) =>
    Object.fromEntries(
      d.items
        .filter((i) =>
          ['BASE_PAY', 'WEEKLY_HOLIDAY_PAY', 'OVERTIME_PAY'].includes(
            i.itemCode,
          ),
        )
        .map((i) => [
          i.itemCode,
          i.isEntered ? (i.adjustedAmount ?? i.calculatedAmount) : null,
        ]),
    );
  /** 화면이 하는 임시저장 — 지금 보이는 값을 그대로 다시 보낸다 */
  const save = (d: Detail, over: object) =>
    send('put', `/payslips/${payslipId}`, 200, {
      updatedAt: d.updatedAt,
      isPremiumApplied: d.isPremiumApplied,
      isWithholdingApplied: d.isWithholdingApplied,
      items: d.items.map((i) => ({
        payslipItemMasterId: i.payslipItemMasterId,
        amount: i.isEntered ? (i.adjustedAmount ?? i.calculatedAmount) : null,
      })),
      ...over,
    });

  it('초안 — 기본급(연장 뺀 근무 × 시급) · 주휴(개근 주 4 × 30,000) · 연장(2시간 × 1.5)', async () => {
    ({ payslipId } = (
      await send('post', '/payslips', 201, { staffMemberId, month: '2026-09' })
    ).body as { payslipId: number });
    const d = await detail();
    expect(amounts(d)).toEqual({
      BASE_PAY: 650_000,
      WEEKLY_HOLIDAY_PAY: 120_000,
      OVERTIME_PAY: 30_000,
    });
    expect(d.grossPayAmount).toBe(800_000);
    // 계약 근무 요일을 모두 출퇴근했다 — 출퇴근 검토 대기 사유가 없다(WHALEERP-229)
    expect(d.reviewReasons).toEqual([]);
  });

  it('가산 적용을 끄면 연장수당을 가산 없이 1배로 계산한다(PAY-05)', async () => {
    await save(await detail(), { isPremiumApplied: false });
    const d = await detail();
    expect(amounts(d)).toEqual({
      BASE_PAY: 650_000,
      WEEKLY_HOLIDAY_PAY: 120_000,
      OVERTIME_PAY: 20_000,
    });
    expect(d.grossPayAmount).toBe(790_000);
  });

  it('출퇴근으로 다시 계산 — 관리자가 고친 기본급을 버리고 계산값으로', async () => {
    const before = await detail();
    const base = before.items.find((i) => i.itemCode === 'BASE_PAY')!;
    await save(before, {
      items: [
        { payslipItemMasterId: base.payslipItemMasterId, amount: 600_000 },
      ],
    });
    expect(amounts(await detail()).BASE_PAY).toBe(600_000);

    await send('post', `/payslips/${payslipId}/recalculate`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    const d = await detail();
    expect(amounts(d).BASE_PAY).toBe(650_000);
    expect(d.logs.map((l) => l.summary)).toContain(
      '출퇴근으로 다시 계산 · 기본급 600,000원 → 650,000원',
    );
  });

  it('목록 — 상단 점포 범위의 점포 유형(storeTypes)으로 거른다, 모르는 유형은 400', async () => {
    const ids = async (types: string) =>
      (
        (
          await send(
            'get',
            `/payslips?month=2026-09&storeIds=${storeId}&storeTypes=${types}`,
            200,
          )
        ).body as { items: { payslipId: number | null }[] }
      ).items.map((i) => i.payslipId);
    expect(await ids('DIRECT')).toEqual([payslipId]);
    expect(await ids('FRANCHISE')).toEqual([]);
    await send('get', '/payslips?month=2026-09&storeTypes=HQ', 400);
  });

  it('점포 · 월 요약 — 명세서의 지급 합계를 고용형태별로 센다(WHALEERP-621)', async () => {
    const { grossPayAmount } = await detail();
    const summary = async (q: string) =>
      (await send('get', `/payslips/summary?${q}`, 200)).body as Record<
        string,
        unknown
      >;
    const zero = { count: 0, grossPayAmount: 0 };
    // 파트타이머 계약 하나의 명세서
    expect(await summary(`storeId=${storeId}&month=2026-09`)).toEqual({
      month: '2026-09',
      total: { count: 1, grossPayAmount },
      fullTime: zero,
      partTime: { count: 1, grossPayAmount },
    });
    expect((await summary(`storeId=${storeId}&month=2026-10`)).total).toEqual(
      zero,
    );
    // 관리 범위 밖(없는) 점포는 목록처럼 0건
    expect((await summary('storeId=2147483647&month=2026-09')).total).toEqual(
      zero,
    );
    await send('get', '/payslips/summary?month=2026-09', 400);
    await send('get', `/payslips/summary?storeId=${storeId}&month=2026-9`, 400);
  });

  it('다시 계산은 그사이 고친 명세서면 409', async () => {
    await send('post', `/payslips/${payslipId}/recalculate`, 409, {
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('검토 대기 분류 — 보정할 날(퇴근 미등록 · 출근·퇴근 모두 없음)과 계약 만료 후 기록을 다시 계산이 붙인다(WHALEERP-229)', async () => {
    // 9/2 퇴근을 지우고(퇴근 미등록), 9/4 기록을 모두 지우고(출근·퇴근 모두 없음), 계약을 9/25 에 끝낸다(9/28 · 9/30 은 만료 뒤)
    const dayRange = (ymd: string) => ({
      gte: at(ymd, 0),
      lt: at(ymd, 24),
    });
    await prisma.attendanceRecord.deleteMany({
      where: {
        staffMemberId,
        kind: 'CHECK_OUT',
        recordedAt: { gte: at('2026-09-02', 0), lt: at('2026-09-05', 0) },
      },
    });
    await prisma.attendanceRecord.deleteMany({
      where: { staffMemberId, recordedAt: dayRange('2026-09-04') },
    });
    await prisma.contract.updateMany({
      where: { staffMemberId },
      data: { endDate: day('2026-09-25') },
    });

    await send('post', `/payslips/${payslipId}/recalculate`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    const d = await detail();
    expect(d.reviewReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewReason: 'MISSING_ATTENDANCE',
          detail:
            '출퇴근 기록이 2일 누락되었습니다 — 09-04 출근·퇴근 모두 없음, 09-02 퇴근 미등록',
        }),
        expect.objectContaining({
          reviewReason: 'AFTER_CONTRACT_END',
          detail:
            '근로계약 만료일(2026-09-25) 뒤 출퇴근 기록이 2일 있습니다 — 09-28, 09-30',
        }),
      ]),
    );
    expect(d.logs.map((l) => l.summary)).toContainEqual(
      expect.stringContaining('출퇴근 누락 추가 · 계약 만료 후 기록 추가'),
    );
  });
  it('다시 계산은 검토 사유를 모두 새로 판정한다 — 확정 · 확정 취소 뒤 확인 표시를 지우고, 기간 중 계약 변경도 붙인다(2026-10-26)', async () => {
    // 빈 칸을 0 으로 채워 확정(남은 사유를 확인) → 확정 취소. 확인 표시는 남아 있다
    const filled = await detail();
    await save(filled, {
      items: filled.items.map((i) => ({
        payslipItemMasterId: i.payslipItemMasterId,
        amount: i.isEntered ? (i.adjustedAmount ?? i.calculatedAmount) : 0,
      })),
    });
    await send('post', `/payslips/${payslipId}/confirm`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    await send('post', `/payslips/${payslipId}/cancel-confirmation`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    const cancelled = await detail();
    expect(cancelled.reviewReasons.length).toBeGreaterThan(0);
    expect(cancelled.reviewReasons.every((r) => r.acknowledgedAt)).toBe(true);

    // 9/26 부터 시급 12,000 새 계약(앞 계약은 9/25 에 끝났다) — 9/28 · 9/30 은 새 계약 시급으로 센다
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'PAPER',
        startDate: day('2026-09-26'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        wageAmount: 12_000,
        weeklyHoliday: 'SUN',
        status: 'SIGNED',
        createdBy: bmId,
        contractWorkDays: {
          create: (['MON', 'WED', 'FRI'] as const).map((weekday) => ({
            weekday,
            startTime: time(10),
            endTime: time(15),
          })),
        },
      },
    });
    await send('post', `/payslips/${payslipId}/recalculate`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    const d = await detail();
    expect(d.reviewReasons.map((r) => r.reviewReason).sort()).toEqual([
      'CONTRACT_CHANGED',
      'MISSING_ATTENDANCE',
    ]);
    expect(d.reviewReasons.every((r) => r.acknowledgedAt === null)).toBe(true);
    // 앞 계약 45시간(연장 2시간 뺀) × 10,000 + 새 계약 9/28 · 9/30 의 10시간 × 12,000
    expect(amounts(d).BASE_PAY).toBe(570_000);
    expect(d.logs.map((l) => l.summary)).toContainEqual(
      expect.stringContaining(
        '계약 만료 후 기록 해소 · 기간 중 계약 변경 추가',
      ),
    );
  });

  it('고용형태가 다른 계약이 섞이면 기본급 · 주휴 · 연장을 계산하지 않고 「기간 중 계약 변경」이 직접 입력을 요구한다(PR #159 리뷰)', async () => {
    // 앞 테스트의 9/26 새 계약을 정직원으로 — 파트타이머 9/1~25 · 정직원 9/26~
    await prisma.contract.updateMany({
      where: { staffMemberId, startDate: day('2026-09-26') },
      data: { employmentType: 'FULL_TIME', baseHours: 209 },
    });
    await send('post', `/payslips/${payslipId}/recalculate`, 200, {
      updatedAt: (await detail()).updatedAt,
    });
    const d = await detail();
    const a = amounts(d);
    expect([a.BASE_PAY, a.WEEKLY_HOLIDAY_PAY, a.OVERTIME_PAY]).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      d.reviewReasons.find((r) => r.reviewReason === 'CONTRACT_CHANGED')
        ?.detail,
    ).toContain('직접 입력해 주세요');
  });
});
