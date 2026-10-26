// BP 휴일은 규칙 한 건으로 저장하고 날짜는 볼 때 계산한다(CONFIG-8 — 날짜를 풀어 저장하지 않는다).
// 날짜는 Prisma 의 @db.Date 와 같은 UTC 자정 Date 다. 「오늘」은 부르는 쪽이 kstToday 로 정해 넘긴다.
import type { RepeatEndType } from '@prisma/client';
import { addDays } from '../staff-members/kst-date';

/** 날짜 계산에 쓰는 bp_holidays 칸. */
export interface HolidayRule {
  holidayTypeCode: string;
  startDate: Date;
  endDate: Date | null;
  holidayRepeatTypeCode: string | null;
  repeatEndType: RepeatEndType | null;
  repeatEndDate: Date | null;
  repeatCount: number | null;
}

/** 오늘 기준 휴일 상태 — 시작 전 · 진행 중(시작했고 아직 끝나지 않음) · 종료(마지막 날짜가 어제 이전). */
export type HolidayState = 'UPCOMING' | 'ONGOING' | 'ENDED';

const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_DAYS: Record<string, number> = { DAILY: 1, WEEKLY: 7 };
/**
 * 날짜를 받는 범위(public_holidays 와 같은 2000~2100). 매월 · 매년 반복과 「다음 날짜」는 여기서 멈추고, 매일 · 매주는
 * 부르는 쪽이 넘긴 기간에서 멈춘다. 저장하는 규칙은 ruleOf 가 2100-12-31 안으로 막는다(지정 횟수 포함).
 */
const LAST_YEAR = 2100;

/** from~to(양 끝 포함)에 걸리는 휴일 날짜, 오름차순. */
export function datesBetween(rule: HolidayRule, from: Date, to: Date): Date[] {
  if (to < from) return [];
  if (rule.holidayTypeCode !== 'REPEAT') {
    const end = rule.endDate ?? rule.startDate;
    const first = max(rule.startDate, from);
    const last = min(end, to);
    const dates: Date[] = [];
    for (let at = first; at <= last; at = addDays(at, 1)) dates.push(at);
    return dates;
  }
  const until = repeatUntil(rule);
  const last = until ? min(until, to) : to;
  const step = STEP_DAYS[rule.holidayRepeatTypeCode ?? ''];
  if (step) {
    // 매일 · 매주는 n 번째 날짜가 시작일 + n×간격이라 처음부터 셀 필요가 없다.
    const offset = Math.max(
      0,
      Math.ceil(daysBetween(rule.startDate, from) / step),
    );
    const limit =
      rule.repeatEndType === 'COUNT' ? (rule.repeatCount ?? 0) : Infinity;
    const dates: Date[] = [];
    for (let n = offset; n < limit; n++) {
      const at = addDays(rule.startDate, n * step);
      if (at > last) break;
      dates.push(at);
    }
    return dates;
  }
  const dates: Date[] = [];
  for (const at of calendarRepeats(rule)) {
    if (at > last) break;
    if (at >= from) dates.push(at);
  }
  return dates;
}

/** 휴일의 마지막 날짜. 끝이 없는 반복이면 null. */
export function lastDateOf(rule: HolidayRule): Date | null {
  if (rule.holidayTypeCode !== 'REPEAT') return rule.endDate ?? rule.startDate;
  if (rule.repeatEndType === 'UNTIL_DATE' && rule.repeatEndDate) {
    const step = STEP_DAYS[rule.holidayRepeatTypeCode ?? ''];
    // 매일 · 매주는 끝 날짜까지 펼치지 않고 바로 구한다 — 목록이 휴일마다 상태를 보므로 요청마다 불린다.
    if (step)
      return addDays(
        rule.startDate,
        Math.floor(daysBetween(rule.startDate, rule.repeatEndDate) / step) *
          step,
      );
    const dates = datesBetween(rule, rule.startDate, rule.repeatEndDate);
    return dates.at(-1) ?? rule.startDate;
  }
  if (rule.repeatEndType === 'COUNT') {
    const step = STEP_DAYS[rule.holidayRepeatTypeCode ?? ''];
    const count = rule.repeatCount ?? 1;
    if (step) return addDays(rule.startDate, (count - 1) * step);
    let last = rule.startDate;
    for (const at of calendarRepeats(rule)) last = at;
    return last;
  }
  return null;
}

/** after 다음 날짜부터 n 개(after 자신은 빼고). 남은 날짜가 모자라면 있는 만큼. */
export function nextDatesAfter(
  rule: HolidayRule,
  after: Date,
  n: number,
): Date[] {
  const from = addDays(after, 1);
  const end = new Date(Date.UTC(LAST_YEAR, 11, 31));
  if (
    rule.holidayTypeCode === 'REPEAT' &&
    !STEP_DAYS[rule.holidayRepeatTypeCode ?? '']
  ) {
    const dates: Date[] = [];
    for (const at of calendarRepeats(rule)) {
      if (at < from) continue;
      dates.push(at);
      if (dates.length === n) break;
    }
    return dates;
  }
  // 매일 · 매주 · 하루 · 기간은 첫 날짜(기준일 다음 날과 시작일 중 늦은 날)부터 n×7 일 안에 n 개가 있다.
  const first = max(from, rule.startDate);
  return datesBetween(rule, from, min(addDays(first, n * 7), end)).slice(0, n);
}

export function holidayStateOf(rule: HolidayRule, today: Date): HolidayState {
  if (rule.startDate > today) return 'UPCOMING';
  const last = lastDateOf(rule);
  return last && last < today ? 'ENDED' : 'ONGOING';
}

/** 반복의 날짜를 넘기지 않는 마지막 날 — 특정 날짜까지면 그 날, 끝이 없거나 횟수면 null(횟수는 따로 센다). */
function repeatUntil(rule: HolidayRule): Date | null {
  return rule.repeatEndType === 'UNTIL_DATE' ? rule.repeatEndDate : null;
}

/**
 * 매월 · 매년 반복 날짜를 시작일부터 차례로. 그 달 · 해에 같은 날이 없으면(31일 · 2월 29일) 건너뛰고 횟수에도
 * 세지 않는다. 종료 조건과 2100년에서 멈춘다.
 */
function* calendarRepeats(rule: HolidayRule): Generator<Date> {
  const yearly = rule.holidayRepeatTypeCode === 'YEARLY';
  const start = rule.startDate;
  const until = repeatUntil(rule);
  const limit =
    rule.repeatEndType === 'COUNT' ? (rule.repeatCount ?? 0) : Infinity;
  let made = 0;
  for (let i = 0; made < limit; i++) {
    const year = start.getUTCFullYear() + (yearly ? i : 0);
    const month = start.getUTCMonth() + (yearly ? 0 : i);
    const at = new Date(Date.UTC(year, month, start.getUTCDate()));
    if (at.getUTCFullYear() > LAST_YEAR) return;
    if (until && at > until) return;
    // Date.UTC 는 없는 날짜를 다음 달로 넘긴다 — 날이 바뀌었으면 그 달에는 같은 날이 없다.
    if (at.getUTCDate() !== start.getUTCDate()) continue;
    made++;
    yield at;
  }
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}
const max = (a: Date, b: Date) => (a > b ? a : b);
const min = (a: Date, b: Date) => (a < b ? a : b);
