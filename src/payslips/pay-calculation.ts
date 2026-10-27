import { EmploymentType, Weekday } from '@prisma/client';

// 지급 항목 계산(WHALEERP-227) — 기본급 · 주휴수당 · 연장수당. 날짜는 모두 한국 날짜 `YYYY-MM-DD` 다.
// 계산식과 가산율은 노무사 검토 대기다(PAY-5). 지금 식은 운영 정책 PAY-02 · 04 의 2026-09-30 「우리 판단」에 2026-10-26 재영 답
// (PAY-04 포괄 연장 · 달을 걸친 주, PAY-05 가산 끔 1배, PAY-22 정직원 일할, 기간 중 계약 변경은 날마다 그날 계약)을 더한 것이다.

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

/** 근로계약 하나의 계산 조건 */
export interface ContractTerms {
  start: string;
  /** 없으면 무기한 */
  end: string | null;
  /** 근로계약 시급(`wage_amount` 는 고용 형태와 상관없이 시급, 2026-10-12) */
  hourlyWage: number | null;
  /** 정직원 월 기본시간(`base_hours`) — 기본급 = 시급 × 월 기본시간 */
  baseHours: number | null;
  /** 계약 요일별 소정근로 분(휴게 뺀). 근무하지 않는 요일은 없다 */
  contractDays: Partial<Record<Weekday, number>>;
  /** 근로계약 월간 연장근무 분(포괄 연장) — 정직원 연장수당은 이것을 넘긴 분만 준다(PAY-04). 없으면 0 */
  includedOvertimeMinutes: number;
}

export interface PayInput {
  employmentType: EmploymentType;
  /**
   * 급여 기간에 걸친 근로계약, 늦게 시작한 것부터. 날마다 그날 효력이 있는 계약으로 계산한다(`contractOn`, 2026-10-26 재영).
   * 비어 있으면(근태 요약에서 계약이 없는 직원) 시급 · 계약 요일 없이 근무 분만 센다
   */
  contracts: readonly ContractTerms[];
  /**
   * 기간 앞 주(급여 기간 첫날이 든 주의 월요일 ~ 전날)만 덮는 앞 계약 — 달을 걸친 주의 앞 달 몫을 그날 계약으로 판정할 때만 쓴다
   * (1일에 재계약하면 앞 계약). 급여 기간 안의 날 · 시급이 없는지 보기에는 쓰지 않는다
   */
  leadingContracts?: readonly ContractTerms[];
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
  /**
   * 급여 기간에 걸친 계약의 고용형태가 섞였다(정직원 ↔ 파트타이머). 정직원 식(월 기본시간 · 일할)과 파트타이머 식(실근무 · 계약 요일 ·
   * 주휴)을 날마다 나눠 쓰는 규칙이 정해지지 않아 기본급 · 주휴 · 연장을 계산하지 않는다(null — 관리자가 넣는다, PR #159 리뷰)
   */
  isEmploymentMixed?: boolean;
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

const periodDays = (input: PayInput) => {
  const out: string[] = [];
  for (let d = input.periodStart; d <= input.periodEnd; d = addDay(d, 1))
    out.push(d);
  return out;
};

/**
 * 그날 효력이 있는 계약 — 그날을 덮는 계약 가운데 가장 늦게 시작한 것(늦게 시작한 것부터 받는다). 어느 계약도 덮지 않는
 * 날(계약 사이 · 만료 뒤 · 시작 전)은 그날 전에 시작한 가장 늦은 계약, 없으면 가장 일찍 시작한 계약으로 센다 — 계약이 하나면
 * 기간 내내 그 계약이다(만료 뒤 기록은 검토 대기 사유로 알린다). 계약이 없으면 null.
 */
export function contractOn<T extends { start: string; end: string | null }>(
  contracts: readonly T[],
  day: string,
): T | null {
  return (
    contracts.find((c) => inRange(day, c.start, c.end)) ??
    contracts.find((c) => c.start <= day) ??
    contracts.at(-1) ??
    null
  );
}

/** 그날 계약 — 급여 기간 앞 날이면 앞 계약까지 본다(`leadingContracts`) */
function termsOn(input: PayInput, day: string): ContractTerms | null {
  if (day >= input.periodStart || !input.leadingContracts?.length)
    return contractOn(input.contracts, day);
  return contractOn(
    [...input.contracts, ...input.leadingContracts].sort((a, b) =>
      b.start.localeCompare(a.start),
    ),
    day,
  );
}

/** 그날을 덮는 계약이 있는가 — 급여 기간 앞 날이면 앞 계약까지 */
const coveredOn = (input: PayInput, day: string) =>
  [
    ...input.contracts,
    ...(day < input.periodStart ? (input.leadingContracts ?? []) : []),
  ].some((c) => inRange(day, c.start, c.end));

const weeklyMinutesOf = (terms: ContractTerms) =>
  Object.values(terms.contractDays).reduce((s, m) => s + (m ?? 0), 0);

/**
 * 주휴 조건(PAY-02) — 날들이 모두 어느 계약 기간 안이고, 그 날들의 소정근로시간(그날 계약 요일) 합이 15시간 이상이고, 그
 * 날들의 소정근로일을 모두 출근했다(지각 · 조퇴도 출근). 한 주 전체로도, 달을 걸친 주의 앞 달 몫으로도 본다.
 */
function holidayQualifies(input: PayInput, days: readonly string[]): boolean {
  let scheduled = 0;
  for (const day of days) {
    if (!coveredOn(input, day)) return false;
    const minutes = termsOn(input, day)?.contractDays[weekdayOf(day)];
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
 * 날별 연장 분.
 * - 하루 — 정직원은 8시간을 넘긴 분. 파트타이머는 그날 계약의 그 요일 소정근로시간(8시간 이하로 본다)을 넘긴 분이고, 계약하지
 *   않은 요일은 전부다(PAY-04 우리 판단, 2026-09-30). 급여 기간 안의 날만 센다.
 * - 주 — 하루 몫을 뺀 근무가 40시간을 넘긴 분. 같은 시간은 한 번만 센다. 달을 걸친 주는 그 주를 맡은 달이 센다(`weeksOf`).
 *   40시간을 넘긴 것은 그 주 뒤쪽 근무라 마지막 날부터 거꾸로 그날 몫에 매긴다 — 그날 계약의 시급으로 셈하려고.
 */
function overtimeByDay(input: PayInput): Map<string, number> {
  const capOf = (day: string) =>
    input.employmentType === 'FULL_TIME'
      ? DAILY_LIMIT
      : Math.min(
          termsOn(input, day)?.contractDays[weekdayOf(day)] ?? 0,
          DAILY_LIMIT,
        );
  const within = (day: string) => Math.min(input.worked[day] ?? 0, capOf(day));
  const weeklyOver = (days: readonly string[]) =>
    Math.max(0, days.reduce((s, day) => s + within(day), 0) - WEEKLY_LIMIT);
  const out = new Map<string, number>();
  const add = (day: string, minutes: number) => {
    if (minutes > 0) out.set(day, (out.get(day) ?? 0) + minutes);
  };
  for (const day of periodDays(input))
    add(day, (input.worked[day] ?? 0) - capOf(day));
  for (const { days, settled } of weeksOf(input)) {
    const week = settled ? weekOf(settled[0]) : days;
    let rest = settled
      ? weeklyOver(week) - weeklyOver(settled)
      : weeklyOver(days);
    for (let i = week.length - 1; i >= 0 && rest > 0; i--) {
      const minutes = Math.min(rest, within(week[i]));
      add(week[i], minutes);
      rest -= minutes;
    }
  }
  return out;
}

/**
 * 주휴를 받는 주의 계약 — 이 기간이 맡은 주 가운데 주휴 조건을 채우고, 그 주 마지막 날(맡은 몫의 마지막 날) 계약의 1주
 * 소정근로시간이 15시간 이상인 주(PAY-02). 한 주가 두 계약에 걸치면 마지막 날 계약으로 센다(1주 소정 · 시급) — 개근은 날마다 그날
 * 계약 요일로 본다. 우리 판단 · 노무 확인 대기(2026-10-26).
 */
function holidayWeeksOf(input: PayInput): ContractTerms[] {
  return weeksOf(input).flatMap(({ days }) => {
    if (days.length === 0) return [];
    const terms = termsOn(input, days[days.length - 1]);
    return terms &&
      weeklyMinutesOf(terms) >= WEEKLY_HOLIDAY_MIN &&
      holidayQualifies(input, days)
      ? [terms]
      : [];
  });
}

/**
 * 계약별 급여 기간 날 수 — 그날 효력이 있는 계약(`contractOn`)으로 나눈다. `employedOnly` 면 입사일 ~ 퇴직일 안의 날만(PAY-22).
 */
function daysByContract(
  input: PayInput,
  employedOnly: boolean,
): Map<ContractTerms, number> {
  const out = new Map<ContractTerms, number>();
  for (const day of periodDays(input)) {
    if (
      employedOnly &&
      ((input.hiredDate && day < input.hiredDate) ||
        (input.retiredDate && day > input.retiredDate))
    )
      continue;
    const terms = termsOn(input, day);
    if (terms) out.set(terms, (out.get(terms) ?? 0) + 1);
  }
  return out;
}

/**
 * 기본급 · 주휴수당 · 연장수당. 급여 기간 중 근로계약이 바뀌면 날마다 그날 효력이 있는 계약으로 나눠 계산한다(2026-10-26 재영).
 * - 정직원: 기본급은 시급 × 월 기본시간(근로계약의 월급, 주휴 포함)이라 주휴수당은 0 이다. 계약마다 그 월급 × 그 계약이
 *   효력인 역일 수 ÷ 기간 역일 수로 나눠 더하고, 급여 기간 중간에 입사 · 퇴사하면 재직 중인 날만 센다(PAY-22) — 계약이 하나면
 *   지금까지의 일할과 같다. 계약별로 나누는 것은 우리 판단 · 노무 확인 대기. 연장수당은 계약마다 그 계약이 효력인 날의 연장 분에서
 *   그 계약 월간 연장(포괄)을 기본급처럼 그 계약이 효력인 재직 역일 비율로 나눈 만큼을 뺀 분 × 그 시급 × 1.5 다(PAY-04, 포괄 일할은
 *   우리 판단 · 노무 확인 대기).
 * - 파트타이머: 기본급은 날마다 연장을 뺀 근무 시간 × 그날 시급, 연장수당은 연장 분 × 그날 시급 × 1.5. 주휴수당은 주마다 1주
 *   소정근로시간 ÷ 40 × 8시간 × 시급(40시간을 넘기지 않는다, 그 주 마지막 날 계약으로).
 * - 가산을 끈 명세서는 연장수당을 가산 없이 1배로 계산한다(PAY-05).
 * - 시급이 없는 계약이 하나라도 있으면 셋 다 계산하지 않는다.
 */
export function calculatePay(input: PayInput): PayResult {
  let workedMinutes = 0;
  for (const day of periodDays(input)) workedMinutes += input.worked[day] ?? 0;
  const overtime = overtimeByDay(input);
  let overtimeMinutes = 0;
  for (const m of overtime.values()) overtimeMinutes += m;
  const partTime = input.employmentType === 'PART_TIME';
  const holidayWeeks = partTime ? holidayWeeksOf(input) : [];
  const weeklyHolidayWeeks = holidayWeeks.length;
  if (
    input.isEmploymentMixed ||
    input.contracts.length === 0 ||
    input.contracts.some((c) => c.hourlyWage === null)
  )
    return {
      basePay: null,
      weeklyHolidayPay: null,
      overtimePay: null,
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
    };
  // 기간 앞 날(달을 걸친 주를 이 달이 맡은 몫)의 연장은 앞 계약 시급, 그 계약에 시급이 없으면 기간 계약으로
  const wageOf = (day: string) =>
    termsOn(input, day)?.hourlyWage ??
    contractOn(input.contracts, day)!.hourlyWage!;

  const rate = input.isPremiumApplied ? OVERTIME_RATE : 1;
  if (!partTime) {
    const total = periodDays(input).length;
    const effective = daysByContract(input, false);
    const employedDays = daysByContract(input, true);
    const employed = [...employedDays];
    const overtimeOf = new Map<ContractTerms, number>();
    for (const [day, m] of overtime) {
      const terms = termsOn(input, day)!;
      overtimeOf.set(terms, (overtimeOf.get(terms) ?? 0) + m);
    }
    let overtimePay = 0;
    for (const [terms, m] of overtimeOf) {
      const included =
        (terms.includedOvertimeMinutes * (employedDays.get(terms) ?? 0)) /
        total;
      overtimePay +=
        (Math.max(0, m - included) / 60) * terms.hourlyWage! * rate;
    }
    return {
      basePay: [...effective.keys()].some((terms) => terms.baseHours === null)
        ? null
        : won(
            employed.reduce(
              (s, [terms, days]) =>
                s + (terms.hourlyWage! * terms.baseHours! * days) / total,
              0,
            ),
          ),
      weeklyHolidayPay: 0,
      overtimePay: won(overtimePay),
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
    };
  }
  let basePay = 0;
  for (const day of periodDays(input))
    basePay += (input.worked[day] ?? 0) * wageOf(day);
  let overtimePay = 0;
  for (const [day, m] of overtime) overtimePay += m * wageOf(day);
  return {
    basePay: won(Math.max(0, basePay - overtimePay) / 60),
    weeklyHolidayPay: won(
      holidayWeeks.reduce(
        (s, terms) =>
          s +
          (Math.min(weeklyMinutesOf(terms), WEEKLY_LIMIT) / WEEKLY_LIMIT) *
            8 *
            terms.hourlyWage!,
        0,
      ),
    ),
    overtimePay: won((overtimePay / 60) * rate),
    workedMinutes,
    overtimeMinutes,
    weeklyHolidayWeeks,
  };
}

/**
 * 한 주(월~일) 근태 요약 — 관리자 웹 출 · 퇴근 현황 「근태 요약」이 급여 계산과 같은 규칙으로 보이게 한다(2026-10-23 사용자 결정).
 * 근무 분(휴게 뺀) · 연장 분 · 주휴 대상(1주 소정근로시간 15시간 이상 · 그 주 계약 요일 개근, 정직원 · 파트타이머 모두)이다.
 * 기간이 월요일 ~ 일요일 한 주가 아니면 급여 계산처럼 달을 걸친 주 규칙(`weeksOf`)이 기간 끝에 걸린다 — 직원 앱 기간 합이 그렇다.
 */
export function weekStats(input: PayInput): {
  workedMinutes: number;
  overtimeMinutes: number;
  weeklyHoliday: boolean;
} {
  let workedMinutes = 0;
  for (const day of periodDays(input)) workedMinutes += input.worked[day] ?? 0;
  let overtimeMinutes = 0;
  for (const m of overtimeByDay(input).values()) overtimeMinutes += m;
  return {
    workedMinutes,
    overtimeMinutes,
    weeklyHoliday: holidayWeeksOf(input).length > 0,
  };
}
