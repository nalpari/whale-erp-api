import { EmploymentType, Weekday } from '@prisma/client';

// 지급 항목 계산(WHALEERP-227) — 기본급 · 주휴수당 · 연장수당. 날짜는 모두 한국 날짜 `YYYY-MM-DD` 다.
// 계산식과 가산율은 노무사 검토 대기다(PAY-5). 지금 식은 운영 정책 PAY-02 · 04 의 2026-09-30 「우리 판단」에 2026-10-26 재영 답
// (PAY-04 포괄 연장 · 달을 걸친 주, PAY-05 가산 끔 1배, PAY-22 정직원 일할)을 더한 것이다.

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
  /** 근로계약 월간 연장근무 분(포괄 연장) — 정직원 연장수당은 이것을 넘긴 분만 준다(PAY-04). 없으면 0 */
  includedOvertimeMinutes: number;
  /** 직원 레코드 입사일 · 퇴직일 — 급여 기간 중간이면 정직원 기본급을 일할한다(PAY-22) */
  hiredDate: string | null;
  retiredDate: string | null;
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
  /** 가산을 끈 명세서는 1배(PAY-05) */
  overtimePay: number | null;
  /** 급여 기간의 근무 분 */
  workedMinutes: number;
  /** 실제 연장 분 — 정직원 포괄 연장을 빼기 전 */
  overtimeMinutes: number;
  /** 주휴를 받은 주 수 */
  weeklyHolidayWeeks: number;
}

const inRange = (day: string, from: string, to: string | null) =>
  day >= from && (to === null || day <= to);
const won = (n: number) => Math.round(n);

const weekOf = (monday: string) =>
  Array.from({ length: 7 }, (_, i) => addDay(monday, i));

/**
 * 주휴 조건(PAY-02) — 날들이 모두 계약 기간 안이고, 그 날들의 소정근로시간 합이 15시간 이상이고, 그 날들의 소정근로일(계약
 * 요일)을 모두 출근했다(지각 · 조퇴도 출근). 한 주 전체로도, 달을 걸친 주의 앞 달 몫으로도 본다.
 */
function holidayQualifies(input: PayInput, days: readonly string[]): boolean {
  let scheduled = 0;
  for (const day of days) {
    if (!inRange(day, input.contractStart, input.contractEnd)) return false;
    const minutes = input.contractDays[weekdayOf(day)];
    if (!minutes) continue;
    if (!(day in input.worked)) return false;
    scheduled += minutes;
  }
  return scheduled >= WEEKLY_HOLIDAY_MIN;
}

/**
 * 급여 기간에 걸친 주(월~일)마다 이 기간이 맡는 몫(PAY-04, 2026-10-26 재영). 달을 걸친 주는 앞 달 몫의 날만으로 주휴 조건을
 * 채우면 앞 달이, 못 채우면 다음 달이 주 전체로 맡는다 — 앞 달 명세서는 다음 달 기록 없이 정할 수 있다.
 * - `days` 주휴 조건 · 주 40시간을 볼 날. 맡지 않는 주는 빈 배열이다.
 * - `settled` 앞 달이 맡은 주의 앞 달 몫 — 주 40시간 연장은 주 전체 몫에서 앞 달이 이미 센 만큼을 빼고 센다.
 */
function weeksOf(
  input: PayInput,
): { days: string[]; settled: string[] | null }[] {
  const out: { days: string[]; settled: string[] | null }[] = [];
  for (
    let monday = mondayOf(input.periodStart);
    monday <= input.periodEnd;
    monday = addDay(monday, 7)
  ) {
    const week = weekOf(monday);
    const before = week.filter((d) => d < input.periodStart);
    const inside = week.filter(
      (d) => d >= input.periodStart && d <= input.periodEnd,
    );
    if (week[6] > input.periodEnd)
      // 다음 달에 걸친 주 — 이 달 몫으로 조건을 채울 때만 이 달이 맡는다
      out.push({
        days: holidayQualifies(input, inside) ? inside : [],
        settled: null,
      });
    else if (before.length && holidayQualifies(input, before))
      out.push({ days: [], settled: before });
    else out.push({ days: week, settled: null });
  }
  return out;
}

/**
 * 연장 분.
 * - 하루 — 정직원은 8시간을 넘긴 분. 파트타이머는 그 요일 소정근로시간(8시간 이하로 본다)을 넘긴 분이고, 계약하지 않은 요일은
 *   전부다(PAY-04 우리 판단, 2026-09-30). 급여 기간 안의 날만 센다.
 * - 주 — 하루 몫을 뺀 근무가 40시간을 넘긴 분. 같은 시간은 한 번만 센다. 달을 걸친 주는 그 주를 맡은 달이 센다(`weeksOf`).
 */
function overtimeMinutesOf(input: PayInput): number {
  const capOf = (day: string) =>
    input.employmentType === 'FULL_TIME'
      ? DAILY_LIMIT
      : Math.min(input.contractDays[weekdayOf(day)] ?? 0, DAILY_LIMIT);
  const weeklyOver = (days: readonly string[]) =>
    Math.max(
      0,
      days.reduce(
        (s, day) => s + Math.min(input.worked[day] ?? 0, capOf(day)),
        0,
      ) - WEEKLY_LIMIT,
    );
  let total = 0;
  for (
    let day = input.periodStart;
    day <= input.periodEnd;
    day = addDay(day, 1)
  )
    total += Math.max(0, (input.worked[day] ?? 0) - capOf(day));
  for (const { days, settled } of weeksOf(input))
    total += settled
      ? weeklyOver(weekOf(settled[0])) - weeklyOver(settled)
      : weeklyOver(days);
  return total;
}

/** 주휴를 받는 주 — 이 기간이 맡은 주 가운데 1주 소정근로시간이 15시간 이상이고 주휴 조건을 채운 주(PAY-02) */
function weeklyHolidayWeeksOf(input: PayInput, weeklyContract: number): number {
  if (weeklyContract < WEEKLY_HOLIDAY_MIN) return 0;
  return weeksOf(input).filter(
    ({ days }) => days.length > 0 && holidayQualifies(input, days),
  ).length;
}

/** 정직원 기본급 일할 비율(PAY-22) — 급여 기간 가운데 입사일 ~ 퇴직일 안의 역일 수 ÷ 기간 역일 수. 나누는 기준은 노무사 확인 대기 */
function employedRatio(input: PayInput): number {
  const from =
    input.hiredDate && input.hiredDate > input.periodStart
      ? input.hiredDate
      : input.periodStart;
  const to =
    input.retiredDate && input.retiredDate < input.periodEnd
      ? input.retiredDate
      : input.periodEnd;
  const days = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS) + 1;
  return Math.max(0, days(from, to)) / days(input.periodStart, input.periodEnd);
}

/**
 * 기본급 · 주휴수당 · 연장수당.
 * - 정직원: 기본급은 시급 × 월 기본시간(근로계약의 월급, 주휴 포함)이라 주휴수당은 0 이다. 급여 기간 중간에 입사 · 퇴사하면
 *   기본급을 일할한다(PAY-22). 연장수당은 근로계약 월간 연장(포괄)을 넘긴 연장 분 × 시급 × 1.5 다(PAY-04).
 * - 파트타이머: 기본급은 연장을 뺀 근무 시간 × 시급, 연장수당은 연장 분 × 시급 × 1.5. 주휴수당은 주마다 1주 소정근로시간 ÷ 40 ×
 *   8시간 × 시급(40시간을 넘기지 않는다).
 * - 가산을 끈 명세서는 연장수당을 가산 없이 1배로 계산한다(PAY-05).
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

  const rate = input.isPremiumApplied ? OVERTIME_RATE : 1;
  if (!partTime)
    return {
      basePay:
        input.baseHours === null
          ? null
          : won(wage * input.baseHours * employedRatio(input)),
      weeklyHolidayPay: 0,
      overtimePay: won(
        (Math.max(0, overtimeMinutes - input.includedOvertimeMinutes) / 60) *
          wage *
          rate,
      ),
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
    };
  return {
    basePay: won((Math.max(0, workedMinutes - overtimeMinutes) / 60) * wage),
    weeklyHolidayPay: won(
      weeklyHolidayWeeks *
        (Math.min(weeklyContract, WEEKLY_LIMIT) / WEEKLY_LIMIT) *
        8 *
        wage,
    ),
    overtimePay: won((overtimeMinutes / 60) * wage * rate),
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
