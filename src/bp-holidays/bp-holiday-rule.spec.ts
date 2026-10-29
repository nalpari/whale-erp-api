import { BadRequestException } from '@nestjs/common';
import { describeRule, ruleOf } from './bp-holiday-rule';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = d('2026-10-26');

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e.message;
    throw e;
  }
  throw new Error('예외가 나지 않았다');
};

describe('ruleOf — 등록 · 수정 입력을 bp_holidays 칸으로 맞춘다', () => {
  it('하루는 종료일을 시작일과 같게, 반복 칸은 비운다', () => {
    expect(
      ruleOf(
        {
          holidayTypeCode: 'DAY',
          startDate: '2026-10-30',
          endDate: '2026-11-30',
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'COUNT',
          repeatCount: 3,
        },
        today,
      ),
    ).toEqual({
      holidayTypeCode: 'DAY',
      startDate: d('2026-10-30'),
      endDate: d('2026-10-30'),
      holidayRepeatTypeCode: null,
      repeatEndType: null,
      repeatEndDate: null,
      repeatCount: null,
    });
  });

  it('반복은 종료일을 비우고 종료 조건에 맞는 칸만 남긴다', () => {
    expect(
      ruleOf(
        {
          holidayTypeCode: 'REPEAT',
          startDate: '2026-10-26',
          endDate: '2026-12-31',
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'UNTIL_DATE',
          repeatEndDate: '2026-12-31',
          repeatCount: 5,
        },
        today,
      ),
    ).toEqual({
      holidayTypeCode: 'REPEAT',
      startDate: d('2026-10-26'),
      endDate: null,
      holidayRepeatTypeCode: 'WEEKLY',
      repeatEndType: 'UNTIL_DATE',
      repeatEndDate: d('2026-12-31'),
      repeatCount: null,
    });
  });

  it.each([
    [
      '지난 시작일',
      { holidayTypeCode: 'DAY', startDate: '2026-10-25' },
      '시작일은 오늘 이후로 정해 주세요.',
    ],
    [
      '기간인데 종료일 없음',
      { holidayTypeCode: 'PERIOD', startDate: '2026-10-27' },
      '기간 휴일은 종료일을 보내 주세요.',
    ],
    [
      '종료일이 시작일보다 이름',
      {
        holidayTypeCode: 'PERIOD',
        startDate: '2026-10-27',
        endDate: '2026-10-26',
      },
      '종료일은 시작일 이후로 정해 주세요.',
    ],
    [
      '반복인데 반복 유형 없음',
      {
        holidayTypeCode: 'REPEAT',
        startDate: '2026-10-27',
        repeatEndType: 'NONE',
      },
      '반복 휴일은 반복 유형과 종료 조건을 보내 주세요.',
    ],
    [
      '특정 날짜까지인데 날짜 없음',
      {
        holidayTypeCode: 'REPEAT',
        startDate: '2026-10-27',
        holidayRepeatTypeCode: 'DAILY',
        repeatEndType: 'UNTIL_DATE',
      },
      '반복 종료일은 시작일 이후로 보내 주세요.',
    ],
    [
      '지정 횟수인데 횟수 없음',
      {
        holidayTypeCode: 'REPEAT',
        startDate: '2026-10-27',
        holidayRepeatTypeCode: 'DAILY',
        repeatEndType: 'COUNT',
      },
      '반복 횟수를 보내 주세요.',
    ],
  ])('%s 는 400', (_, input, message) => {
    expect(messageOf(() => ruleOf(input, today))).toBe(message);
  });

  it.each([
    [{ holidayTypeCode: 'DAY', startDate: '2101-01-01' }],
    [
      {
        holidayTypeCode: 'PERIOD',
        startDate: '2100-12-30',
        endDate: '2101-01-02',
      },
    ],
    [
      {
        holidayTypeCode: 'REPEAT',
        startDate: '2100-01-01',
        holidayRepeatTypeCode: 'DAILY',
        repeatEndType: 'UNTIL_DATE',
        repeatEndDate: '2101-01-01',
      },
    ],
  ])('2100년 뒤 날짜는 400 — 목록 · 공식 휴일과 같은 상한 %#', (input) => {
    expect(messageOf(() => ruleOf(input, today))).toBe(
      '날짜는 2100-12-31 까지 정할 수 있습니다.',
    );
  });

  it.each([
    ['매주 9999회', 'WEEKLY', '2026-11-02', 9999],
    ['매년 100회(2100년까지 75번뿐)', 'YEARLY', '2026-11-02', 100],
  ])('지정 횟수가 2100-12-31 을 넘으면 400 — %s', (_, type, start, count) => {
    expect(
      messageOf(() =>
        ruleOf(
          {
            holidayTypeCode: 'REPEAT',
            startDate: start,
            holidayRepeatTypeCode: type,
            repeatEndType: 'COUNT',
            repeatCount: count,
          },
          today,
        ),
      ),
    ).toBe(
      '반복 횟수가 2100-12-31 을 넘습니다 — 횟수를 줄이거나 종료일을 정해 주세요.',
    );
  });

  it('2100년 안에 끝나는 지정 횟수는 받는다', () => {
    expect(
      ruleOf(
        {
          holidayTypeCode: 'REPEAT',
          startDate: '2026-11-02',
          holidayRepeatTypeCode: 'YEARLY',
          repeatEndType: 'COUNT',
          repeatCount: 75,
        },
        today,
      ).repeatCount,
    ).toBe(75);
  });

  it('지난 시작일을 허용하면(진행 중인 휴일의 같은 값) 막지 않는다', () => {
    expect(
      ruleOf({ holidayTypeCode: 'DAY', startDate: '2026-10-01' }, today, {
        allowPastStart: true,
      }).startDate,
    ).toEqual(d('2026-10-01'));
  });
});

describe('describeRule — 변경 이력 · 화면에 쓰는 날짜 표현', () => {
  it.each([
    [
      ruleOf({ holidayTypeCode: 'DAY', startDate: '2026-10-30' }, today),
      '하루 · 2026-10-30',
    ],
    [
      ruleOf(
        {
          holidayTypeCode: 'PERIOD',
          startDate: '2026-10-30',
          endDate: '2026-11-02',
        },
        today,
      ),
      '기간 · 2026-10-30 ~ 2026-11-02',
    ],
    [
      ruleOf(
        {
          holidayTypeCode: 'REPEAT',
          startDate: '2026-10-30',
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
        },
        today,
      ),
      '매주 · 시작 2026-10-30 · 종료일 없음',
    ],
    [
      ruleOf(
        {
          holidayTypeCode: 'REPEAT',
          startDate: '2026-10-30',
          holidayRepeatTypeCode: 'MONTHLY',
          repeatEndType: 'COUNT',
          repeatCount: 3,
        },
        today,
      ),
      '매월 · 시작 2026-10-30 · 3회',
    ],
    [
      ruleOf(
        {
          holidayTypeCode: 'REPEAT',
          startDate: '2026-10-30',
          holidayRepeatTypeCode: 'YEARLY',
          repeatEndType: 'UNTIL_DATE',
          repeatEndDate: '2030-10-30',
        },
        today,
      ),
      '매년 · 시작 2026-10-30 · 2030-10-30까지',
    ],
  ])('%#', (rule, text) => {
    expect(describeRule(rule)).toBe(text);
  });
});
