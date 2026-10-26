import { EmploymentType, Prisma, PrismaClient, Weekday } from '@prisma/client';
import { addDays, kstDayStart } from '../staff-members/kst-date';
import {
  CONTRACT_END_SELECT,
  effectiveEnd,
  periodContractIds,
} from './payslip-attendance-reasons';
import {
  calculatePay,
  contractOn,
  ContractTerms,
  mondayOf,
  PayInput,
  PayResult,
} from './pay-calculation';

type Db = PrismaClient | Prisma.TransactionClient;

/** 시스템이 계산하는 지급 항목 코드(payslip_item_masters.is_system_calculated) */
export const CALCULATED_ITEM_CODES = [
  'BASE_PAY',
  'WEEKLY_HOLIDAY_PAY',
  'OVERTIME_PAY',
] as const;
export type CalculatedItemCode = (typeof CALCULATED_ITEM_CODES)[number];

const KST_MS = 9 * 60 * 60 * 1000;
const kstDate = (at: Date) =>
  new Date(at.getTime() + KST_MS).toISOString().slice(0, 10);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const timeMinutes = (t: Date) => t.getUTCHours() * 60 + t.getUTCMinutes();
const WEEKDAYS: readonly Weekday[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];

export interface PayslipBasis {
  staffMemberId: number;
  /**
   * 급여 기간에 걸친 체결 완료 근로계약(`periodContractIds`). 날마다 그날 효력이 있는 계약으로 계산한다. 비어 있으면(근태 요약에서
   * 계약이 없는 직원) 시급 · 계약 요일 없이 근무 분만 센다
   */
  contractIds: readonly number[];
  employmentType: EmploymentType;
  periodStartDate: Date;
  periodEndDate: Date;
  isPremiumApplied: boolean;
}

/**
 * 명세서 하나의 기본급 · 주휴수당 · 연장수당(WHALEERP-227). 급여 기간에 걸친 근로계약의 시급 · 월 기본시간 · 월간
 * 연장 · 요일별 근무(날마다 그날 효력이 있는 계약, 2026-10-26)와 그 직원 레코드의 입사일 · 퇴직일 · 출퇴근 기록으로 셈한다.
 *
 * 하루 근무는 그날(한국) 출근한 기록과 그 짝 퇴근 사이의 분 합에서 휴게를 뺀 것이다. 휴게는 그날 근무스케줄의 휴게 분,
 * 근무스케줄이 없으면 그날 계약의 그 요일 휴게다. 퇴근이 없는 출근은 0 분이지만 출근한 날로는 센다(주휴 개근). 확인 필요 사유가
 * 남은 기록도 넣는다(ATT-11 — 명세서에 검토 대기 사유로 알린다).
 */
export async function calculatePayslip(
  db: Db,
  basis: PayslipBasis,
): Promise<PayResult> {
  return calculatePay(await payInputOf(db, basis));
}

/** 계산 입력 — 근로계약 · 그 직원 레코드의 출퇴근 기록 · 근무스케줄 휴게를 읽어 PayInput 으로 */
export async function payInputOf(
  db: Db,
  basis: PayslipBasis,
): Promise<PayInput> {
  const periodStart = ymd(basis.periodStartDate);
  const periodEnd = ymd(basis.periodEndDate);
  const monday = new Date(`${mondayOf(periodStart)}T00:00:00Z`);
  const from = kstDayStart(monday);
  const to = kstDayStart(addDays(basis.periodEndDate, 1));
  // 계산은 기간 앞 주(월요일부터)의 날도 본다 — 달을 걸친 주의 주휴 · 주 40시간을 앞 달 몫까지 그날 계약으로 판정해야 해서, 그 날들을
  // 덮는 계약도 읽는다(1일에 재계약하면 앞 계약). 명세서가 참조하는 계약 · 계약 변경 사유는 기간 계약(`basis.contractIds`) 그대로다
  const leading =
    monday < basis.periodStartDate
      ? await periodContractIds(
          db,
          basis.staffMemberId,
          monday,
          addDays(basis.periodStartDate, -1),
        )
      : [];
  const contractIds = [...new Set([...basis.contractIds, ...leading])];

  const [contracts, staff, checkIns, schedules] = await Promise.all([
    db.contract.findMany({
      where: { contractId: { in: contractIds } },
      orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
      select: {
        contractId: true,
        wageAmount: true,
        baseHours: true,
        monthlyOvertimeHours: true,
        startDate: true,
        ...CONTRACT_END_SELECT,
        contractWorkDays: {
          select: {
            weekday: true,
            startTime: true,
            endTime: true,
            breakStartTime: true,
            breakEndTime: true,
          },
        },
      },
    }),
    db.staffMember.findUniqueOrThrow({
      where: { staffMemberId: basis.staffMemberId },
      select: { hiredDate: true, retiredDate: true },
    }),
    db.attendanceRecord.findMany({
      where: {
        staffMemberId: basis.staffMemberId,
        kind: 'CHECK_IN',
        recordedAt: { gte: from, lt: to },
      },
      select: { attendanceRecordId: true, recordedAt: true },
    }),
    db.workSchedule.findMany({
      where: {
        staffMemberId: basis.staffMemberId,
        isDeleted: false,
        startAt: { gte: from, lt: to },
      },
      select: { startAt: true, breakMinutes: true },
    }),
  ]);
  const checkOuts = await db.attendanceRecord.findMany({
    where: {
      kind: 'CHECK_OUT',
      checkInAttendanceRecordId: {
        in: checkIns.map((r) => r.attendanceRecordId),
      },
    },
    select: { checkInAttendanceRecordId: true, recordedAt: true },
  });
  const outOf = new Map(
    checkOuts.map((r) => [r.checkInAttendanceRecordId, r.recordedAt]),
  );

  const terms: (ContractTerms & {
    contractId: number;
    breaks: Partial<Record<Weekday, number>>;
  })[] = contracts.map((c) => {
    const contractDays: Partial<Record<Weekday, number>> = {};
    const breaks: Partial<Record<Weekday, number>> = {};
    for (const d of c.contractWorkDays) {
      const rest =
        d.breakStartTime && d.breakEndTime
          ? timeMinutes(d.breakEndTime) - timeMinutes(d.breakStartTime)
          : 0;
      contractDays[d.weekday] =
        timeMinutes(d.endTime) - timeMinutes(d.startTime) - rest;
      breaks[d.weekday] = rest;
    }
    return {
      contractId: c.contractId,
      start: c.startDate ? ymd(c.startDate) : periodStart,
      end: effectiveEnd(c),
      hourlyWage: c.wageAmount,
      baseHours: c.baseHours === null ? null : Number(c.baseHours),
      contractDays,
      includedOvertimeMinutes: c.monthlyOvertimeHours
        ? Math.round(Number(c.monthlyOvertimeHours) * 60)
        : 0,
      breaks,
    };
  });
  const scheduledBreak = new Map<string, number>();
  for (const s of schedules) {
    const day = kstDate(s.startAt);
    scheduledBreak.set(day, (scheduledBreak.get(day) ?? 0) + s.breakMinutes);
  }

  const raw = new Map<string, number>();
  for (const r of checkIns) {
    const day = kstDate(r.recordedAt);
    const out = outOf.get(r.attendanceRecordId);
    const minutes = out
      ? Math.max(
          0,
          Math.floor((out.getTime() - r.recordedAt.getTime()) / 60_000),
        )
      : 0;
    raw.set(day, (raw.get(day) ?? 0) + minutes);
  }
  const worked: Record<string, number> = {};
  for (const [day, minutes] of raw) {
    const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
    const rest =
      scheduledBreak.get(day) ?? contractOn(terms, day)?.breaks[weekday] ?? 0;
    worked[day] = Math.max(0, minutes - rest);
  }

  return {
    employmentType: basis.employmentType,
    // 앞 계약은 기간 앞 날에만 쓴다 — 기간 안 공백일 · 시급 없음 판정에 섞이지 않게(계약이 없으면 근무 분만 세는 규칙도 그대로)
    contracts: terms.filter((t) => basis.contractIds.includes(t.contractId)),
    leadingContracts: terms.filter(
      (t) => !basis.contractIds.includes(t.contractId),
    ),
    hiredDate: staff.hiredDate ? ymd(staff.hiredDate) : null,
    retiredDate: staff.retiredDate ? ymd(staff.retiredDate) : null,
    periodStart,
    periodEnd,
    worked,
    isPremiumApplied: basis.isPremiumApplied,
  };
}

/** 항목 코드별 계산값 */
export const amountsOf = (
  r: PayResult,
): Record<CalculatedItemCode, number | null> => ({
  BASE_PAY: r.basePay,
  WEEKLY_HOLIDAY_PAY: r.weeklyHolidayPay,
  OVERTIME_PAY: r.overtimePay,
});
