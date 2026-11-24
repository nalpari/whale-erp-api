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
/** 가산 1.5배를 정수로 — 분자 3 · 분모 2(정수 셈, roundDiv) */
const OVERTIME_RATE_FRACTION = [3, 2] as const;
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

/** 명세서 한 줄의 계산 근거(WHALEERP-755) — 쓴 시간(분)과 한 줄 계산식. 계산하지 않은 항목은 둘 다 null */
export interface PayBasis {
  minutes: number | null;
  text: string | null;
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
  /**
   * 금액마다 시간 · 한 줄 계산식(근로기준법 시행령 제27조의2 5호 — 계산방법, 연장근로 시간 수. WHALEERP-755, 2026-11-20 김지영).
   * 금액과 같은 분 · 같은 시급으로 적고, 시급이 둘 이상이면 시급별 구간을 「 + 」로 잇는다
   */
  basis: {
    basePay: PayBasis;
    weeklyHolidayPay: PayBasis;
    overtimePay: PayBasis;
  };
}

const NO_BASIS: PayBasis = { minutes: null, text: null };
/**
 * 식에 적는 분 — 분 단위로 반올림한다(주휴 ÷ 5 · 정직원 포괄 일할은 소수 분이 나온다). 식 검증은 이 분으로 다시 곱한다(formula).
 */
export const shownMinutes = (minutes: number) => Math.round(minutes);

/**
 * 시간 글자 — 소수 첫째 자리로 정확하면(분이 6의 배수) 「7.8시간」 · 「8.0시간」 · 「0.0시간」, 아니면 「7시간 50분」 · 「31분」. 소수
 * 첫째 자리로 반올림하면 470분이 「7.8시간」(468분)이 되어 식을 다시 곱한 값이 금액과 달랐다(재영 리뷰, WHALEERP-755). 계산식 · 시간만
 * 남긴 칸 · 야간 · 휴일 · 「직접 입력」 모두 이 글자를 쓰고, 관리자 상세 · 직원 앱 · PDF 는 api 가 만든 글자를 그대로 보인다.
 */
export const hoursText = (minutes: number) => {
  const m = shownMinutes(minutes);
  if (m % 6 === 0) return `${(m / 60).toFixed(1)}시간`;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}시간 ${m % 60}분` : `${m % 60}분`;
};
const wageText = (wage: number) => `${wage.toLocaleString('ko-KR')}원`;
const addTo = <K>(map: Map<K, number>, key: K, n: number) =>
  map.set(key, (map.get(key) ?? 0) + n);

/** calculation_text 칸 길이(varchar(200)) */
export const CALCULATION_TEXT_MAX = 200;

/** 식의 한 구간 — 글자에 보이는 값(보이는 분 · 시급 · 배율 분자 · 일수)을 곱한 정수 분자와 글자. 분모는 식마다 하나다(formula) */
type Segment = [numerator: number, text: string];

/**
 * 구간을 「 + 」로 이은 한 줄 계산식. 식에 보이는 값으로 셈한 원(구간 분자의 합 ÷ 분모, 원 단위 반올림 — calculatePay 의 금액과 같은
 * roundDiv)이 실제 금액과 같을 때만 낸다(아니면 null — 시간만 남긴다, withHours). 0 분 이하 구간을 뺐을 때 · 소수 분을 분 단위로 반올림해
 * 적을 때처럼 식을 읽은 사람이 셈한 원이 금액과 다르면 직원에게 보이지 않는다(WHALEERP-755 리뷰 · 재영 리뷰). 셈은 정수 분자로 해 .5
 * 경계에서 부동소수 오차로 뒤집히지 않는다(최종 게이트 — 전에는 반올림 전 값의 소수 오차 갈래를 따로 두었다).
 * 200자(칸 길이)를 넘어도 null 이다 — 넘기면 저장이 500 이 된다. 한 달에 계약 조건(시급 · 월 기본시간)이 6~7번 바뀌어야 넘친다.
 */
function formula(
  segments: readonly Segment[],
  denominator: number,
  amount: number,
): string | null {
  const numerator = segments.reduce((s, [n]) => s + n, 0);
  if (roundDiv(numerator, denominator) !== amount) return null;
  const text = segments.map(([, t]) => t).join(' + ');
  return text.length > CALCULATION_TEXT_MAX ? null : text;
}

/**
 * 시간과 식을 한 칸으로 — 식을 비웠으면(금액과 맞지 않음 · 200자 초과) 시간이 있을 때 시간만 「8.0시간」으로 남긴다(야간 · 휴일근무수당과
 * 같은 모양). 연장 · 야간 · 휴일근로의 시간 수는 법정 기재사항이라 관리자 상세 · 직원 앱 · PDF 세 곳에서 빠지지 않게(PR #317 리뷰).
 * 시간이 없으면(정직원 기본급) NULL 그대로다.
 */
export const withHours = (
  minutes: number | null,
  text: string | null,
): PayBasis => ({
  minutes,
  text: text ?? (minutes === null ? null : hoursText(minutes)),
});

/**
 * 계산 항목의 시간 · 식 — withHours 에 더해, 금액이 있는데 시간이 분 단위로 0 이면(정직원 연장의 지급 대상 분이 포괄을 일할해 빼고 0.5분
 * 미만으로 남은 때) 시간 · 식을 모두 비운다(최종 게이트). 「0.0시간」은 금액과 맞지 않고, 0 분은 「금액이 있으면 시간 > 0」(야간 · 휴일)과
 * 같은 칸에서 「시간 없음」으로 읽혀 NULL 이 맞다.
 */
const calculatedBasis = (
  minutes: number,
  text: string | null,
  amount: number,
): PayBasis =>
  text === null && shownMinutes(minutes) === 0 && amount > 0
    ? NO_BASIS
    : withHours(shownMinutes(minutes), text);

/**
 * 시급별 분을 구간으로 — 먼저 넣은 시급부터. 0 분 이하 구간은 빼고(그래서 금액과 어긋나면 formula 가 식을 내지 않는다), 다 빠지면(연장
 * 없음 등) 기간 끝 계약 시급으로 0 분 한 구간을 적는다 — 0원 줄도 같은 모양의 식이 보이게.
 */
function wageSegments(
  minutesByWage: ReadonlyMap<number, number>,
  fallbackWage: number,
  segment: (wage: number, minutes: number) => Segment,
): Segment[] {
  const shown = [...minutesByWage].filter(([, m]) => m > 0);
  return (shown.length ? shown : [[fallbackWage, 0]]).map(([wage, m]) =>
    segment(wage, m),
  );
}

const inRange = (day: string, from: string, to: string | null) =>
  day >= from && (to === null || day <= to);
/**
 * 정수 분자 ÷ 분모를 원 단위로 반올림(Math.round 와 같이 .5 는 올림, 분자 0 이상). 정수끼리 나머지로 셈해 부동소수 오차 없이 정확하다 —
 * 주휴(÷ 5 ÷ 60 × 시급)를 부동소수로 셈하면 정확히 X.5 원인 금액이 X.4999… 가 되어 1원 내려갔다(최종 게이트).
 */
export function roundDiv(numerator: number, denominator: number): number {
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  // Math.floor 가 경계에서 하나 어긋나도 나머지로 바로잡는다
  if (r < 0) return roundDiv(numerator + denominator, denominator) - 1;
  if (r >= denominator)
    return roundDiv(numerator - denominator, denominator) + 1;
  return 2 * r >= denominator ? q + 1 : q;
}

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

/** 하루 연장이 아닌 한도 — 정직원은 8시간, 파트타이머는 그날 계약의 그 요일 소정근로시간(8시간 이하, 계약하지 않은 요일은 0) */
const dailyCapOf = (input: PayInput, day: string) =>
  input.employmentType === 'FULL_TIME'
    ? DAILY_LIMIT
    : Math.min(
        termsOn(input, day)?.contractDays[weekdayOf(day)] ?? 0,
        DAILY_LIMIT,
      );

/** 그날 근무 가운데 하루 연장을 뺀 분 */
const withinDailyCap = (input: PayInput, day: string) =>
  Math.min(input.worked[day] ?? 0, dailyCapOf(input, day));

/**
 * 날별 연장 분.
 * - 하루 — 정직원은 8시간을 넘긴 분. 파트타이머는 그날 계약의 그 요일 소정근로시간(8시간 이하로 본다)을 넘긴 분이고, 계약하지
 *   않은 요일은 전부다(PAY-04 우리 판단, 2026-09-30). 급여 기간 안의 날만 센다.
 * - 주 — 하루 몫을 뺀 근무가 40시간을 넘긴 분. 같은 시간은 한 번만 센다. 달을 걸친 주는 그 주를 맡은 달이 센다(`weeksOf`).
 *   40시간을 넘긴 것은 그 주 뒤쪽 근무라 마지막 날부터 거꾸로 그날 몫에 매긴다 — 그날 계약의 시급으로 셈하려고.
 */
function overtimeByDay(input: PayInput): Map<string, number> {
  const capOf = (day: string) => dailyCapOf(input, day);
  const within = (day: string) => withinDailyCap(input, day);
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
 * 주휴를 받는 주 — 이 기간이 맡은 주 가운데 주휴 조건을 채우고, 그 주 마지막 날(맡은 몫의 마지막 날) 계약의 1주
 * 소정근로시간이 15시간 이상인 주(PAY-02). 한 주가 두 계약에 걸치면 마지막 날 계약으로 센다(1주 소정 · 시급) — 개근은 날마다 그날
 * 계약 요일로 본다. 우리 판단 · 노무 확인 대기(2026-10-26). `workedMinutes` 는 그 주(맡은 날)의 실근무에서 하루 연장을 뺀 분(40시간
 * 상한 전)이다 — 주휴 금액을 센다. 주 40시간 초과는 `calculatePay` 가 금액에서 40시간 상한으로 뺀다(PAY-04 v237, 2026-10-29 재영).
 */
function holidayWeeksOf(
  input: PayInput,
): { terms: ContractTerms; workedMinutes: number }[] {
  return weeksOf(input).flatMap(({ days }) => {
    if (days.length === 0) return [];
    const terms = termsOn(input, days[days.length - 1]);
    if (
      !terms ||
      weeklyMinutesOf(terms) < WEEKLY_HOLIDAY_MIN ||
      !holidayQualifies(input, days)
    )
      return [];
    const workedMinutes = days.reduce(
      (s, d) => s + withinDailyCap(input, d),
      0,
    );
    return [{ terms, workedMinutes }];
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
 * - 파트타이머: 기본급은 날마다 연장을 뺀 근무 시간 × 그날 시급, 연장수당은 연장 분 × 그날 시급 × 1.5. 주휴수당은 주마다 그 주
 *   실근무 시간(출퇴근 기록)에서 연장을 뺀 시간 ÷ 5 × 시급이고 40시간 상한이다(그 주 마지막 날 계약 시급으로, PAY-05 v234 · PAY-04
 *   v237, 2026-10-28 · 29 재영 — 노무사 답 「총근무시간 ÷ 5」). 연장은 계약 소정근로시간 · 하루 8시간 · 주 40시간을 넘긴 시간이라
 *   계약 소정근로시간 안에서 일한 시간까지만 센다. 가산을 끈 명세서도 같다. 주휴 대상은 그대로 계약 소정 15시간 · 개근으로 본다.
 *   달을 걸친 주를 앞 달이 맡으면 앞 달 날의 실근무만 센다(다음 달 보충 없음, PAY-04 v237).
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
      basis: {
        basePay: NO_BASIS,
        weeklyHolidayPay: NO_BASIS,
        overtimePay: NO_BASIS,
      },
    };
  // 기간 앞 날(달을 걸친 주를 이 달이 맡은 몫)의 연장은 앞 계약 시급, 그 계약에 시급이 없으면 기간 계약으로
  const wageOf = (day: string) =>
    termsOn(input, day)?.hourlyWage ??
    contractOn(input.contracts, day)!.hourlyWage!;

  const rate = input.isPremiumApplied ? OVERTIME_RATE : 1;
  // 금액은 정수 분자 ÷ 분모로 셈하고 roundDiv 로 원 단위 반올림한다 — 부동소수로 셈하면 .5 경계에서 1원 어긋났다(최종 게이트)
  const [rateNum, rateDen] = input.isPremiumApplied
    ? OVERTIME_RATE_FRACTION
    : ([1, 1] as const);
  // 계산식 — 0원 줄의 시급, 연장 구간의 날짜 순서
  const fallbackWage = contractOn(
    input.contracts,
    input.periodEnd,
  )!.hourlyWage!;
  const overtimeDays = [...overtime].sort(([a], [b]) => a.localeCompare(b));
  /** 연장 식 — 보이는 분 × 시급 × 배율 분자, 분모 60 × 배율 분모 */
  const overtimeText = (
    minutesByWage: ReadonlyMap<number, number>,
    amount: number,
  ) =>
    formula(
      wageSegments(minutesByWage, fallbackWage, (wage, m) => [
        shownMinutes(m) * wage * rateNum,
        `${hoursText(m)} × ${wageText(wage)} × ${rate}배`,
      ]),
      60 * rateDen,
      amount,
    );
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
    // 지급 대상 연장 분 × 기간 일수(정수) — 포괄 연장을 재직 역일로 일할해 뺀 분(m − 포괄 × 재직일 ÷ 기간 일)을 기간 일수로 곱해 정수로 둔다
    let overtimeNum = 0;
    const payableOf = new Map<ContractTerms, number>();
    for (const [terms, m] of overtimeOf) {
      const payableTimesTotal = Math.max(
        0,
        m * total -
          terms.includedOvertimeMinutes * (employedDays.get(terms) ?? 0),
      );
      payableOf.set(terms, payableTimesTotal / total);
      overtimeNum += payableTimesTotal * terms.hourlyWage! * rateNum;
    }
    const overtimePay = roundDiv(overtimeNum, total * 60 * rateDen);
    const noBaseHours = [...effective.keys()].some(
      (terms) => terms.baseHours === null,
    );
    // 계산식 — 기본급은 시급 · 월 기본시간이 같은 계약끼리 날 수를 모은다(재직 역일이 기간 전체면 일할 꼬리를 뺀다). 연장은 계약이
    // 시작한 순서로 그 계약의 지급 분(포괄을 뺀 분)을 시급별로 모은다
    const monthly = new Map<
      string,
      { wage: number; hours: number; days: number }
    >();
    for (const [terms, days] of employed) {
      const key = `${terms.hourlyWage}/${terms.baseHours}`;
      const g = monthly.get(key) ?? {
        wage: terms.hourlyWage!,
        hours: terms.baseHours!,
        days: 0,
      };
      g.days += days;
      monthly.set(key, g);
    }
    const payable = new Map<number, number>();
    for (const [terms, m] of [...payableOf].sort(([a], [b]) =>
      a.start.localeCompare(b.start),
    ))
      addTo(payable, terms.hourlyWage!, m);
    const payableMinutes = [...payable.values()].reduce((s, m) => s + m, 0);
    // 기본급 = Σ 시급 × 월 기본시간 × 재직일 ÷ 기간 일 — 월 기본시간은 소수 첫째 자리(numeric(5,1))라 × 10 해 정수 분자로
    const tenths = (hours: number) => Math.round(hours * 10);
    const basePay = noBaseHours
      ? null
      : roundDiv(
          employed.reduce(
            (s, [terms, days]) =>
              s + terms.hourlyWage! * tenths(terms.baseHours!) * days,
            0,
          ),
          total * 10,
        );
    return {
      basePay,
      weeklyHolidayPay: 0,
      overtimePay,
      workedMinutes,
      overtimeMinutes,
      weeklyHolidayWeeks,
      basis: {
        basePay:
          basePay === null
            ? NO_BASIS
            : withHours(
                null,
                formula(
                  (monthly.size
                    ? [...monthly.values()]
                    : [
                        {
                          wage: fallbackWage,
                          hours: contractOn(input.contracts, input.periodEnd)!
                            .baseHours!,
                          days: 0,
                        },
                      ]
                  ).map(({ wage, hours, days }): Segment => [
                    wage * tenths(hours) * days,
                    `${wageText(wage)} × 월 ${hours}시간` +
                      (days === total ? '' : ` × ${days}일 / ${total}일`),
                  ]),
                  total * 10,
                  basePay,
                ),
              ),
        weeklyHolidayPay: { minutes: null, text: '기본급에 포함' },
        overtimePay: calculatedBasis(
          payableMinutes,
          overtimeText(payable, overtimePay),
          overtimePay,
        ),
      },
    };
  }
  // 분 × 시급의 합(정수) — 기본급은 연장을 뺀 근무, 연장은 그날 시급으로
  let workedNum = 0;
  for (const day of periodDays(input))
    workedNum += (input.worked[day] ?? 0) * wageOf(day);
  let overtimeNum = 0;
  for (const [day, m] of overtime) overtimeNum += m * wageOf(day);
  const basePay = roundDiv(Math.max(0, workedNum - overtimeNum), 60);
  const overtimePay = roundDiv(overtimeNum * rateNum, 60 * rateDen);
  // 계산식 — 기본급은 날마다 그날 시급으로 근무 분을 모으고 연장 분을 뺀다. 주휴는 그 주 마지막 날 계약 시급별로 주 수와
  // Σ min(실근무, 40시간) 을 모은다(÷ 5 는 식에 적는다 — 나눈 소수 분을 적으면 식이 금액과 어긋났다, 최종 게이트). 연장은 날짜 순으로 그날 시급별
  const baseByWage = new Map<number, number>();
  for (const day of periodDays(input))
    addTo(baseByWage, wageOf(day), input.worked[day] ?? 0);
  const overtimeByWage = new Map<number, number>();
  for (const [day, m] of overtimeDays) {
    addTo(baseByWage, wageOf(day), -m);
    addTo(overtimeByWage, wageOf(day), m);
  }
  type Holiday = { weeks: number; worked: number };
  const holidayByWage = new Map<number, Holiday>();
  for (const { terms, workedMinutes: m } of holidayWeeks) {
    const g = holidayByWage.get(terms.hourlyWage!) ?? { weeks: 0, worked: 0 };
    g.weeks += 1;
    g.worked += Math.min(m, WEEKLY_LIMIT);
    holidayByWage.set(terms.hourlyWage!, g);
  }
  // 주휴 = Σ min(주 실근무, 40시간) × 시급 ÷ 300(÷ 5 ÷ 60) — 정수 분자(최종 게이트)
  const weeklyHolidayPay = roundDiv(
    holidayWeeks.reduce(
      (s, { terms, workedMinutes: m }) =>
        s + Math.min(m, WEEKLY_LIMIT) * terms.hourlyWage!,
      0,
    ),
    300,
  );
  // 주휴 시간(work_minutes)은 ÷ 5 한 분이다 — 관리자 상세 · 직원 앱 · PDF 의 시간 수가 「주휴 시간」으로 읽히게(식은 나누기 전 실근무로 적는다)
  const holidayMinutes = holidayWeeks.reduce(
    (s, { workedMinutes: m }) => s + Math.min(m, WEEKLY_LIMIT) / 5,
    0,
  );
  const sum = (map: ReadonlyMap<number, number>) =>
    [...map.values()].reduce((s, m) => s + m, 0);
  return {
    basePay,
    weeklyHolidayPay,
    overtimePay,
    workedMinutes,
    overtimeMinutes,
    weeklyHolidayWeeks,
    basis: {
      basePay: withHours(
        Math.max(0, sum(baseByWage)),
        formula(
          wageSegments(baseByWage, fallbackWage, (wage, m) => [
            shownMinutes(m) * wage,
            `${hoursText(m)} × ${wageText(wage)}`,
          ]),
          60,
          basePay,
        ),
      ),
      weeklyHolidayPay: withHours(
        Math.round(holidayMinutes),
        formula(
          (holidayByWage.size
            ? [...holidayByWage]
            : [[fallbackWage, { weeks: 0, worked: 0 }] as [number, Holiday]]
          ).map(([wage, { weeks, worked }]): Segment => [
            worked * wage,
            `${weeks}주 · 실근무(주 40시간까지) ${hoursText(worked)} ÷ 5 × ${wageText(wage)}`,
          ]),
          300,
          weeklyHolidayPay,
        ),
      ),
      overtimePay: withHours(
        sum(overtimeByWage),
        overtimeText(overtimeByWage, overtimePay),
      ),
    },
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
