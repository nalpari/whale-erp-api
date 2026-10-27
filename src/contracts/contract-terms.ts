import { Prisma } from '@prisma/client';
import { dateOnly } from '../common/date-only';

/**
 * 근무 요일 select — weekday enum 순서(MON → SUN)로 정렬된다. 계약서 근무 조건과 직원 목록(WHALEERP-622)이 같이 쓴다.
 */
export const CONTRACT_WORK_DAYS_SELECT = {
  orderBy: { weekday: 'asc' },
  select: {
    weekday: true,
    startTime: true,
    endTime: true,
    breakStartTime: true,
    breakEndTime: true,
  },
} satisfies Prisma.Contract$contractWorkDaysArgs;

/**
 * 계약서에 그리는 근무 조건 — 관리자 상세(작성 화면 다시 채우기)와 직원 앱 상세(WHALEERP-610)가 같은 칸 · 같은 변환을
 * 쓴다. 조항 문장은 아직 템플릿이 없어(노무사 검토 전, WHALEERP-131) 값만 준다.
 */
export const CONTRACT_TERMS_SELECT = {
  startDate: true,
  endDate: true,
  workLocation: true,
  weeklyHoliday: true,
  wageAmount: true,
  mealAllowanceAmount: true,
  carAllowanceAmount: true,
  childcareAllowanceAmount: true,
  baseHours: true,
  monthlyOvertimeHours: true,
  baseNightHours: true,
  baseHolidayHours: true,
  monthlyExtraHolidayHours: true,
  annualLeaveTerms: true,
  severancePayTerms: true,
  payMonth: true,
  payDay: true,
  payMethod: true,
  probationMonths: true,
  probationWageReductionRate: true,
  isHealthPensionInsured: true,
  isEmploymentInjuryInsured: true,
  contractWorkDays: CONTRACT_WORK_DAYS_SELECT,
} satisfies Prisma.ContractSelect;

export const hhmm = (d: Date) => d.toISOString().slice(11, 16);
// numeric(5,1) 은 Prisma 가 Decimal 로 준다. 30분 단위라 number 로 바꿔도 값이 같다.
const hoursOf = (d: Prisma.Decimal | null) =>
  d === null ? null : d.toNumber();

/** CONTRACT_WORK_DAYS_SELECT 로 읽은 근무 요일 → 응답 칸(시각 HH:mm) */
export const workDaysOf = (
  days: Prisma.ContractWorkDayGetPayload<{
    select: typeof CONTRACT_WORK_DAYS_SELECT.select;
  }>[],
) =>
  days.map((d) => ({
    weekday: d.weekday,
    startTime: hhmm(d.startTime),
    endTime: hhmm(d.endTime),
    breakStartTime: d.breakStartTime ? hhmm(d.breakStartTime) : null,
    breakEndTime: d.breakEndTime ? hhmm(d.breakEndTime) : null,
  }));

/** CONTRACT_TERMS_SELECT 로 읽은 행 → 응답 칸(날짜 YYYY-MM-DD · 시각 HH:mm · 시간 number) */
export function contractTermsOf(
  c: Prisma.ContractGetPayload<{ select: typeof CONTRACT_TERMS_SELECT }>,
) {
  return {
    startDate: dateOnly(c.startDate),
    endDate: dateOnly(c.endDate),
    workLocation: c.workLocation,
    weeklyHoliday: c.weeklyHoliday,
    wageAmount: c.wageAmount,
    mealAllowanceAmount: c.mealAllowanceAmount,
    carAllowanceAmount: c.carAllowanceAmount,
    childcareAllowanceAmount: c.childcareAllowanceAmount,
    baseHours: hoursOf(c.baseHours),
    monthlyOvertimeHours: hoursOf(c.monthlyOvertimeHours),
    baseNightHours: hoursOf(c.baseNightHours),
    baseHolidayHours: hoursOf(c.baseHolidayHours),
    monthlyExtraHolidayHours: hoursOf(c.monthlyExtraHolidayHours),
    annualLeaveTerms: c.annualLeaveTerms,
    severancePayTerms: c.severancePayTerms,
    payMonth: c.payMonth,
    payDay: c.payDay,
    payMethod: c.payMethod,
    probationMonths: c.probationMonths,
    probationWageReductionRate: c.probationWageReductionRate,
    isHealthPensionInsured: c.isHealthPensionInsured,
    isEmploymentInjuryInsured: c.isEmploymentInjuryInsured,
    workDays: workDaysOf(c.contractWorkDays),
  };
}
