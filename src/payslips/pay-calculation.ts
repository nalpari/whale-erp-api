import { EmploymentType, Weekday } from '@prisma/client';

// 지급 항목 계산(WHALEERP-227) — 기본급 · 주휴수당 · 연장수당. 날짜는 모두 한국 날짜 `YYYY-MM-DD` 다.
// 계산식과 가산율은 노무사 검토 대기다(PAY-5). 지금 식은 운영 정책 PAY-02 · 04 의 2026-09-30 「우리 판단」이다.

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 8 * 60;
const WEEKLY_LIMIT = 40 * 60;
/** 주휴를 주는 1주 소정근로시간 하한(PAY-02) */
const WEEKLY_HOLIDAY_MIN = 15 * 60;
const OVERTIME_RATE = 1.5;
const WEEKDAYS: readonly Weekday[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];

export const addDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
const weekdayOf = (day: string) =>
  WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
/** 그날이 든 주의 월요일 — 주는 월~일 */
export function mondayOf(day: string): string {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDay(day, -((wd + 6) % 7));
}

export interface PayInput {
  employmentType: EmploymentType;
  /** 근로계약 시급(`wage_amount` 는 고용 형태와 상관없이 시급, 2026-10-12) */
  hourlyWage: number | null;
  /** 정직원 월 기본시간(`base_hours`) — 기본급 = 시급 × 월 기본시간 */
  baseHours: number | null;
  /** 계약 요일별 소정근로 분(휴게 뺀). 근무하지 않는 요일은 없다 */
  contractDays: Partial<Record<Weekday, number>>;
  contractStart: string;
  contractEnd: string | null;
  periodStart: string;
  periodEnd: string;
  /**
   * 출근한 날별 근무 분(퇴근까지, 휴게 뺀). 퇴근이 없는 출근은 0 분으로 들어 있다 — 출근한 날(개근)로는 센다.
   * 주휴 · 주 40시간은 주 전체를 보므로 급여 기간 첫날이 든 주의 월요일부터 넣는다.
   */
  worked: Record<string, number>;
  /** 연장 · 야간 · 휴일 가산 적용(명세서 값, PAY-05) */
  isPremiumApplied: boolean;
}

export interface PayResult {
  /** 원. 계산할 수 없으면(시급 · 월 기본시간 없음) null */
  basePay: number | null;
  weeklyHolidayPay: number | null;
  /** 가산을 끈 명세서는 계산하지 않는다(null, PAY-05) */
  overtimePay: number | null;
  /** 급여 기간의 근무 분 */
  workedMinutes: number;
  overtimeMinutes: number;
  /** 주휴를 받은 주 수 */
  weeklyHolidayWeeks: number;
}

const inRange = (day: string, from: string, to: string | null) =>
  day >= from && (to === null || day <= to);
const won = (n: number) => Math.round(n);

/**
 * 연장 분.
 * - 하루 — 정직원은 8시간을 넘긴 분. 파트타이머는 그 요일 소정근로시간(8시간 이하로 본다)을 넘긴 분이고, 계약하지 않은 요일은
 *   전부다(PAY-04 우리 판단, 2026-09-30).
 * - 주 — 하루 몫을 뺀 근무가 40시간을 넘긴 분. 같은 시간은 한 번만 센다.
 * 하루 몫은 급여 기간 안의 날만, 주 몫은 일요일이 급여 기간 안인 주만 센다 — 달을 걸친 주는 일요일이 든 달에서 한 번 센다.
 */
function overtimeMinutesOf(input: PayInput): number {
  const capOf = (day: string) =>
    input.employmentType === 'FULL_TIME'
      ? DAILY_LIMIT
      : Math.min(input.contractDays[weekdayOf(day)] ?? 0, DAILY_LIMIT);
  let total = 0;
  for (
    let day = input.periodStart;
    day <= input.periodEnd;
    day = addDay(day, 1)
  )
    total += Math.max(0, (input.worked[day] ?? 0) - capOf(day));
  for (
    let monday = mondayOf(input.periodStart);
    addDay(monday, 6) <= input.periodEnd;
    monday = addDay(monday, 7)
  ) {
    let regular = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDay(monday, i);
      regular += Math.min(input.worked[day] ?? 0, capOf(day));
    }
    total += Math.max(0, regular - WEEKLY_LIMIT);
  }
  return total;
}

/**
 * 주휴를 받는 주 — 일요일이 급여 기간 안이고, 주 전체가 계약 기간 안이고, 1주 소정근로시간이 15시간 이상이고, 그 주
 * 소정근로일(계약 요일)을 모두 출근한 주(지각 · 조퇴도 출근, PAY-02).
 */
function weeklyHolidayWeeksOf(input: PayInput, weeklyContract: number): number {
  if (weeklyContract < WEEKLY_HOLIDAY_MIN) return 0;
  let weeks = 0;
  for (
    let monday = mondayOf(input.periodStart);
    addDay(monday, 6) <= input.periodEnd;
    monday = addDay(monday, 7)
  ) {
    const sunday = addDay(monday, 6);
    if (
      !inRange(monday, input.contractStart, input.contractEnd) ||
      !inRange(sunday, input.contractStart, input.contractEnd)
    )
      continue;
    let perfect = true;
    for (let i = 0; i < 7; i++) {
      const day = addDay(monday, i);
      if (input.contractDays[weekdayOf(day)] && !(day in input.worked)) {
        perfect = false;
        break;
      }
    }
    if (perfect) weeks++;
  }
  return weeks;
}

/**
 * 기본급 · 주휴수당 · 연장수당.
 * - 정직원: 기본급은 시급 × 월 기본시간(근로계약의 월급, 주휴 포함)이라 주휴수당은 0 이다. 연장수당은 연장 분 × 시급 × 1.5.
 * - 파트타이머: 기본급은 근무 시간 × 시급. 가산을 켠 명세서는 연장 분을 기본급에서 빼고 연장수당(× 1.5)으로 준다. 주휴수당은
 *   주마다 1주 소정근로시간 ÷ 40 × 8시간 × 시급(40시간을 넘기지 않는다).
 * - 가산을 끈 명세서는 연장수당을 계산하지 않는다(PAY-05) — 파트타이머의 그 시간은 기본급에 그대로 남는다.
 */
export function calculatePay(input: PayInput): PayResult {
  let workedMinutes = 0;
  for (
    let day = input.periodStart;
    day <= input.periodEnd;
    day = addDay(day, 1)
  )
    workedMinutes += input.worked[day] ?? 0;
  const overtimeMinutes = overtimeMinutesOf(input);
  const weeklyContract = Object.values(input.contractDays).reduce(
    (s, m) => s + (m ?? 0),
    0,
  );
  const partTime = input.employmentType === 'PART_TIME';
  const weeklyHolidayWeeks = partTime
    ? weeklyHolidayWeeksOf(input, weeklyContract)
    : 0;
  const wage = input.hourlyWage;
  if (wage === null)
    return {
      basePay: null,
      weeklyHolidayPay: null,
      overtimePay: null,
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
    };

  const overtimePay = input.isPremiumApplied
    ? won((overtimeMinutes / 60) * wage * OVERTIME_RATE)
    : null;
  if (!partTime)
    return {
      basePay: input.baseHours === null ? null : won(wage * input.baseHours),
      weeklyHolidayPay: 0,
      overtimePay,
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
    };
  const paidAsBase = input.isPremiumApplied
    ? workedMinutes - overtimeMinutes
    : workedMinutes;
  return {
    basePay: won((Math.max(0, paidAsBase) / 60) * wage),
    weeklyHolidayPay: won(
      weeklyHolidayWeeks *
        (Math.min(weeklyContract, WEEKLY_LIMIT) / WEEKLY_LIMIT) *
        8 *
        wage,
    ),
    overtimePay,
    workedMinutes,
    overtimeMinutes,
    weeklyHolidayWeeks,
  };
}

/**
 * 한 주(월~일) 근태 요약 — 관리자 웹 출 · 퇴근 현황 「근태 요약」이 급여 계산과 같은 규칙으로 보이게 한다(2026-10-23 사용자 결정).
 * 근무 분(휴게 뺀) · 연장 분 · 주휴 대상(1주 소정근로시간 15시간 이상 · 그 주 계약 요일 개근, 정직원 · 파트타이머 모두)이다.
 * input 의 기간은 그 주 월요일 ~ 일요일이어야 한다.
 */
export function weekStats(input: PayInput): {
  workedMinutes: number;
  overtimeMinutes: number;
  weeklyHoliday: boolean;
} {
  let workedMinutes = 0;
  for (
    let day = input.periodStart;
    day <= input.periodEnd;
    day = addDay(day, 1)
  )
    workedMinutes += input.worked[day] ?? 0;
  const weeklyContract = Object.values(input.contractDays).reduce(
    (s, m) => s + (m ?? 0),
    0,
  );
  return {
    workedMinutes,
    overtimeMinutes: overtimeMinutesOf(input),
    weeklyHoliday: weeklyHolidayWeeksOf(input, weeklyContract) > 0,
  };
}
