import type { Weekday } from '@prisma/client';

// 근무일(@db.Date 모양, UTC 자정)과 시각(HH:mm)은 한국 시각이다. 근무스케줄 칸(timestamptz)은 그 순간으로 저장한다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

/** 시작 HH:mm — 30분 단위(00분 · 30분)만(2026-10-21 재영) */
export const START_TIME_PATTERN = /^([01][0-9]|2[0-3]):[03]0$/;
/** 종료 HH:mm — 30분 단위, 24:00 도 받는다(그날 자정까지) */
export const END_TIME_PATTERN = /^(([01][0-9]|2[0-3]):[03]0|24:00)$/;

const minutesOf = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export type Span = { startAt: Date; endAt: Date };

/**
 * 근무일 + 시작 · 종료를 순간 둘로 바꾼다. 종료가 시작보다 이르면 다음 날이다(자정 넘김, 2026-10-21 재영 결정 1).
 * 길이가 24시간이면(시작 = 종료, 00:00~24:00) null — 한 건은 24시간보다 짧다.
 */
export function toSpan(
  workDate: Date,
  startTime: string,
  endTime: string,
): Span | null {
  const start = minutesOf(startTime);
  let end = minutesOf(endTime);
  if (end <= start) end += DAY_MINUTES;
  if (end - start >= DAY_MINUTES) return null;
  const base = workDate.getTime() - KST_OFFSET_MS;
  return {
    startAt: new Date(base + start * MINUTE_MS),
    endAt: new Date(base + end * MINUTE_MS),
  };
}

/** 근무일 — 시작 일시의 한국 날짜(결정 1). 계약 기간 · 퇴직일 · 주 집계 · 월 달력이 모두 이것을 쓴다. */
export function workDateOf(startAt: Date): Date {
  const shifted = new Date(startAt.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/** 순간을 한국 시각 HH:mm 로. 자정에 끝나면 00:00 이다(화면은 종료가 시작보다 이르면 다음 날로 읽는다). */
export function kstTimeOf(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);
}

/** 휴게는 0 이상, 근무 길이보다 짧다. */
export function breakFits(span: Span, breakMinutes: number): boolean {
  return (
    breakMinutes < (span.endAt.getTime() - span.startAt.getTime()) / MINUTE_MS
  );
}

const WEEKDAYS: Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** 근무일의 요일 — 계약 근무일(contract_work_days)을 찾는다. */
export function weekdayOf(workDate: Date): Weekday {
  return WEEKDAYS[workDate.getUTCDay()];
}

/** @db.Time 값(1970-01-01 의 그 시각, UTC 로 온다)을 HH:mm 로. */
const timeOf = (t: Date) => t.toISOString().slice(11, 16);

/**
 * 계약의 그 요일 근무시간을 근무스케줄 기본값으로. 휴게 시작 · 종료는 길이(분)로 바꾼다(결정 4). 계약 근무시간은 같은 날
 * 안이라(종업이 시업보다 뒤) 자정 넘김이 없다.
 */
export function defaultsOf(day: {
  startTime: Date;
  endTime: Date;
  breakStartTime: Date | null;
  breakEndTime: Date | null;
}): { startTime: string; endTime: string; breakMinutes: number } {
  const breakMinutes =
    day.breakStartTime && day.breakEndTime
      ? (day.breakEndTime.getTime() - day.breakStartTime.getTime()) / MINUTE_MS
      : 0;
  return {
    startTime: timeOf(day.startTime),
    endTime: timeOf(day.endTime),
    breakMinutes,
  };
}
