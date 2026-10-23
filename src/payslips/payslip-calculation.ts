import { EmploymentType, Prisma, PrismaClient, Weekday } from '@prisma/client';
import { addDays, kstDayStart } from '../staff-members/kst-date';
import { calculatePay, mondayOf, PayInput, PayResult } from './pay-calculation';

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
  /** 참조한 근로계약. 없으면(근태 요약에서 계약이 없는 직원) 시급 · 계약 요일 없이 근무 분만 센다 */
  contractId: number | null;
  employmentType: EmploymentType;
  periodStartDate: Date;
  periodEndDate: Date;
  isPremiumApplied: boolean;
}

/**
 * 명세서 하나의 기본급 · 주휴수당 · 연장수당(WHALEERP-227). 근로계약(명세서가 참조한 계약)의 시급 · 월 기본시간 · 요일별
 * 근무와 그 직원 레코드의 출퇴근 기록으로 셈한다.
 *
 * 하루 근무는 그날(한국) 출근한 기록과 그 짝 퇴근 사이의 분 합에서 휴게를 뺀 것이다. 휴게는 그날 근무스케줄의 휴게 분,
 * 근무스케줄이 없으면 그 요일 계약 휴게다. 퇴근이 없는 출근은 0 분이지만 출근한 날로는 센다(주휴 개근). 확인 필요 사유가
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
  const from = kstDayStart(new Date(`${mondayOf(periodStart)}T00:00:00Z`));
  const to = kstDayStart(addDays(basis.periodEndDate, 1));

  const [contract, checkIns, schedules] = await Promise.all([
    db.contract.findUnique({
      where: { contractId: basis.contractId ?? 0 },
      select: {
        wageAmount: true,
        baseHours: true,
        startDate: true,
        endDate: true,
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

  const contractDays: Partial<Record<Weekday, number>> = {};
  const contractBreak: Partial<Record<Weekday, number>> = {};
  for (const d of contract?.contractWorkDays ?? []) {
    const rest =
      d.breakStartTime && d.breakEndTime
        ? timeMinutes(d.breakEndTime) - timeMinutes(d.breakStartTime)
        : 0;
    contractDays[d.weekday] =
      timeMinutes(d.endTime) - timeMinutes(d.startTime) - rest;
    contractBreak[d.weekday] = rest;
  }
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
    const rest = scheduledBreak.get(day) ?? contractBreak[weekday] ?? 0;
    worked[day] = Math.max(0, minutes - rest);
  }

  return {
    employmentType: basis.employmentType,
    hourlyWage: contract?.wageAmount ?? null,
    baseHours:
      contract?.baseHours === null || contract === null
        ? null
        : Number(contract.baseHours),
    contractDays,
    contractStart: contract?.startDate ? ymd(contract.startDate) : periodStart,
    contractEnd: contract?.endDate ? ymd(contract.endDate) : null,
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
