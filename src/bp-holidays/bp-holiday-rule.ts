// 등록 · 수정 입력을 bp_holidays 칸으로 맞추고(WHALEERP-551), 날짜 표현을 한 곳에서 만든다.
// 형식 검사(날짜 모양 · 값 목록)는 DTO 가 먼저 하고, 여기서는 칸 사이의 규칙을 본다.
import { BadRequestException } from '@nestjs/common';
import type { RepeatEndType } from '@prisma/client';
import { dateOnly } from '../common/date-only';
import { parseDateOnly } from '../staff-members/kst-date';
import { datesBetween, type HolidayRule } from './holiday-dates';

export const HOLIDAY_TYPES = ['DAY', 'PERIOD', 'REPEAT'] as const;
export const REPEAT_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export const REPEAT_END_TYPES = ['NONE', 'UNTIL_DATE', 'COUNT'] as const;

const TYPE_LABEL: Record<string, string> = {
  DAY: '하루',
  PERIOD: '기간',
  REPEAT: '반복',
};
const REPEAT_LABEL: Record<string, string> = {
  DAILY: '매일',
  WEEKLY: '매주',
  MONTHLY: '매월',
  YEARLY: '매년',
};

/** DTO 의 날짜 · 반복 칸(문자열 날짜). 유형과 맞지 않는 칸은 무시하고 비운다. */
export interface RuleInput {
  holidayTypeCode: string;
  startDate: string;
  endDate?: string | null;
  holidayRepeatTypeCode?: string | null;
  repeatEndType?: string | null;
  repeatEndDate?: string | null;
  repeatCount?: number | null;
}

/**
 * 입력을 저장할 규칙으로. 하루는 종료일 = 시작일, 기간은 종료일, 반복은 종료일 없이 반복 칸만 남긴다(반복 종료일은
 * 특정 날짜까지일 때만, 횟수는 지정 횟수일 때만). 지난 시작일(한국 날짜)은 저장하지 않는다(CONFIG-9) — 진행 중인
 * 휴일을 같은 값으로 다시 보내는 수정만 allowPastStart 로 넘긴다.
 */
export function ruleOf(
  input: RuleInput,
  today: Date,
  { allowPastStart = false }: { allowPastStart?: boolean } = {},
): HolidayRule {
  const startDate = parseDateOnly(input.startDate);
  if (!startDate)
    throw new BadRequestException('시작일을 YYYY-MM-DD 로 보내 주세요.');
  if (!allowPastStart && startDate < today)
    throw new BadRequestException('시작일은 오늘 이후로 정해 주세요.');
  const rule = shapeOf(input, startDate);
  // 목록 · 날짜 계산 · 공식 휴일이 모두 2100년에서 멈춘다 — 그 뒤 날짜는 어디에도 보이지 않으므로 받지 않는다.
  if (
    [rule.startDate, rule.endDate, rule.repeatEndDate].some(
      (x) => x && x > LAST_DATE,
    )
  )
    throw new BadRequestException('날짜는 2100-12-31 까지 정할 수 있습니다.');
  // 지정 횟수는 날짜 칸이 없어 위에서 걸리지 않는다 — 2100년 안에 그 횟수가 다 나오는지 센다.
  if (
    rule.repeatEndType === 'COUNT' &&
    datesBetween(rule, rule.startDate, LAST_DATE).length <
      (rule.repeatCount ?? 0)
  )
    throw new BadRequestException(
      '반복 횟수가 2100-12-31 을 넘습니다 — 횟수를 줄이거나 종료일을 정해 주세요.',
    );
  return rule;
}

const LAST_DATE = new Date(Date.UTC(2100, 11, 31));

function shapeOf(input: RuleInput, startDate: Date): HolidayRule {
  const empty = {
    holidayRepeatTypeCode: null,
    repeatEndType: null,
    repeatEndDate: null,
    repeatCount: null,
  };
  if (input.holidayTypeCode === 'DAY')
    return { holidayTypeCode: 'DAY', startDate, endDate: startDate, ...empty };
  if (input.holidayTypeCode === 'PERIOD') {
    const endDate = input.endDate ? parseDateOnly(input.endDate) : null;
    if (!endDate)
      throw new BadRequestException('기간 휴일은 종료일을 보내 주세요.');
    if (endDate < startDate)
      throw new BadRequestException('종료일은 시작일 이후로 정해 주세요.');
    return { holidayTypeCode: 'PERIOD', startDate, endDate, ...empty };
  }
  const repeatEndType = input.repeatEndType as RepeatEndType | undefined;
  if (!input.holidayRepeatTypeCode || !repeatEndType)
    throw new BadRequestException(
      '반복 휴일은 반복 유형과 종료 조건을 보내 주세요.',
    );
  const base = {
    holidayTypeCode: 'REPEAT',
    startDate,
    endDate: null,
    holidayRepeatTypeCode: input.holidayRepeatTypeCode,
    repeatEndType,
    repeatEndDate: null,
    repeatCount: null,
  };
  if (repeatEndType === 'UNTIL_DATE') {
    const repeatEndDate = input.repeatEndDate
      ? parseDateOnly(input.repeatEndDate)
      : null;
    if (!repeatEndDate || repeatEndDate < startDate)
      throw new BadRequestException('반복 종료일은 시작일 이후로 보내 주세요.');
    return { ...base, repeatEndDate };
  }
  if (repeatEndType === 'COUNT') {
    if (!input.repeatCount)
      throw new BadRequestException('반복 횟수를 보내 주세요.');
    return { ...base, repeatCount: input.repeatCount };
  }
  return base;
}

/** 두 규칙이 같은 날짜를 만드는 같은 값인가 — 진행 중인 휴일의 수정이 날짜를 건드렸는지 본다. */
export function sameRule(a: HolidayRule, b: HolidayRule): boolean {
  return describeRule(a) === describeRule(b);
}

/** 변경 이력 · 안내에 쓰는 날짜 표현. 예: `매주 · 시작 2026-10-30 · 종료일 없음`. */
export function describeRule(rule: HolidayRule): string {
  const start = dateOnly(rule.startDate);
  if (rule.holidayTypeCode !== 'REPEAT') {
    const end = dateOnly(rule.endDate ?? rule.startDate);
    return rule.holidayTypeCode === 'DAY'
      ? `${TYPE_LABEL.DAY} · ${start}`
      : `${TYPE_LABEL.PERIOD} · ${start} ~ ${end}`;
  }
  return `${REPEAT_LABEL[rule.holidayRepeatTypeCode ?? ''] ?? rule.holidayRepeatTypeCode} · 시작 ${start} · ${repeatEndText(rule)}`;
}

function repeatEndText(rule: HolidayRule): string {
  if (rule.repeatEndType === 'UNTIL_DATE')
    return `${dateOnly(rule.repeatEndDate)}까지`;
  if (rule.repeatEndType === 'COUNT') return `${rule.repeatCount}회`;
  return '종료일 없음';
}
