import {
  datesBetween,
  holidayStateOf,
  lastDateOf,
  nextDatesAfter,
  type HolidayRule,
} from './holiday-dates';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (dates: Date[]) => dates.map((x) => x.toISOString().slice(0, 10));

const day = (start: string): HolidayRule => ({
  holidayTypeCode: 'DAY',
  startDate: d(start),
  endDate: d(start),
  holidayRepeatTypeCode: null,
  repeatEndType: null,
  repeatEndDate: null,
  repeatCount: null,
});
const period = (start: string, end: string): HolidayRule => ({
  ...day(start),
  holidayTypeCode: 'PERIOD',
  endDate: d(end),
});
const repeat = (
  start: string,
  type: string,
  end:
    | { repeatEndType: 'NONE' }
    | { repeatEndType: 'UNTIL_DATE'; repeatEndDate: string }
    | { repeatEndType: 'COUNT'; repeatCount: number } = {
    repeatEndType: 'NONE',
  },
): HolidayRule => ({
  holidayTypeCode: 'REPEAT',
  startDate: d(start),
  endDate: null,
  holidayRepeatTypeCode: type,
  repeatEndType: end.repeatEndType,
  repeatEndDate: 'repeatEndDate' in end ? d(end.repeatEndDate) : null,
  repeatCount: 'repeatCount' in end ? end.repeatCount : null,
});

describe('datesBetween — 규칙에서 기간 안의 날짜를 계산한다(양 끝 포함)', () => {
  it('하루는 그 날짜 하나', () => {
    expect(
      iso(datesBetween(day('2026-10-09'), d('2026-10-01'), d('2026-10-31'))),
    ).toEqual(['2026-10-09']);
    expect(
      datesBetween(day('2026-10-09'), d('2026-11-01'), d('2026-11-30')),
    ).toEqual([]);
  });

  it('기간은 시작~종료의 모든 날 중 고른 기간에 걸친 것', () => {
    expect(
      iso(
        datesBetween(
          period('2026-09-29', '2026-10-02'),
          d('2026-10-01'),
          d('2026-10-31'),
        ),
      ),
    ).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('매일 · 매주는 시작일부터 같은 간격', () => {
    expect(
      iso(
        datesBetween(
          repeat('2026-09-28', 'DAILY'),
          d('2026-10-01'),
          d('2026-10-03'),
        ),
      ),
    ).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    // 2026-09-21 은 월요일 — 10월의 월요일만
    expect(
      iso(
        datesBetween(
          repeat('2026-09-21', 'WEEKLY'),
          d('2026-10-01'),
          d('2026-10-31'),
        ),
      ),
    ).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('시작일보다 앞 날짜는 없다', () => {
    expect(
      iso(
        datesBetween(
          repeat('2026-10-20', 'WEEKLY'),
          d('2026-10-01'),
          d('2026-10-31'),
        ),
      ),
    ).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('매월 31일은 31일이 없는 달을 건너뛴다', () => {
    expect(
      iso(
        datesBetween(
          repeat('2026-01-31', 'MONTHLY'),
          d('2026-01-01'),
          d('2026-06-30'),
        ),
      ),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it('매년 2월 29일은 윤년에만', () => {
    expect(
      iso(
        datesBetween(
          repeat('2024-02-29', 'YEARLY'),
          d('2024-01-01'),
          d('2032-12-31'),
        ),
      ),
    ).toEqual(['2024-02-29', '2028-02-29', '2032-02-29']);
  });

  it('특정 날짜까지는 그날까지만', () => {
    expect(
      iso(
        datesBetween(
          repeat('2026-09-21', 'WEEKLY', {
            repeatEndType: 'UNTIL_DATE',
            repeatEndDate: '2026-10-12',
          }),
          d('2026-10-01'),
          d('2026-10-31'),
        ),
      ),
    ).toEqual(['2026-10-05', '2026-10-12']);
  });

  it('지정 횟수는 건너뛴 날짜를 세지 않는다', () => {
    // 1/31 · 3/31 · 5/31 이 세 번 — 2월 · 4월은 없어서 세지 않는다
    expect(
      iso(
        datesBetween(
          repeat('2026-01-31', 'MONTHLY', {
            repeatEndType: 'COUNT',
            repeatCount: 3,
          }),
          d('2026-01-01'),
          d('2026-12-31'),
        ),
      ),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(
      iso(
        datesBetween(
          repeat('2026-09-21', 'WEEKLY', {
            repeatEndType: 'COUNT',
            repeatCount: 2,
          }),
          d('2026-09-01'),
          d('2026-12-31'),
        ),
      ),
    ).toEqual(['2026-09-21', '2026-09-28']);
  });

  it('먼 기간도 매일 반복을 처음부터 세지 않고 계산한다', () => {
    expect(
      iso(
        datesBetween(
          repeat('2000-01-01', 'DAILY'),
          d('2100-12-30'),
          d('2100-12-31'),
        ),
      ),
    ).toEqual(['2100-12-30', '2100-12-31']);
  });

  it('지정 횟수의 매일 · 매주도 횟수 안에서만', () => {
    expect(
      iso(
        datesBetween(
          repeat('2026-10-01', 'DAILY', {
            repeatEndType: 'COUNT',
            repeatCount: 3,
          }),
          d('2026-10-02'),
          d('2026-10-31'),
        ),
      ),
    ).toEqual(['2026-10-02', '2026-10-03']);
  });
});

describe('lastDateOf — 휴일의 마지막 날짜(끝이 없으면 null)', () => {
  it.each([
    ['하루', day('2026-10-09'), '2026-10-09'],
    ['기간', period('2026-10-01', '2026-10-05'), '2026-10-05'],
    [
      '특정 날짜까지(그날이 반복 날짜가 아니면 그 전 마지막)',
      repeat('2026-09-21', 'WEEKLY', {
        repeatEndType: 'UNTIL_DATE',
        repeatEndDate: '2026-10-15',
      }),
      '2026-10-12',
    ],
    [
      '지정 횟수',
      repeat('2026-01-31', 'MONTHLY', {
        repeatEndType: 'COUNT',
        repeatCount: 3,
      }),
      '2026-05-31',
    ],
  ])('%s', (_, rule, expected) => {
    expect(lastDateOf(rule)?.toISOString().slice(0, 10)).toBe(expected);
  });

  it('먼 날짜까지인 매일 반복도 펼치지 않고 바로 구한다', () => {
    const rule = repeat('2000-01-01', 'DAILY', {
      repeatEndType: 'UNTIL_DATE',
      repeatEndDate: '2100-12-31',
    });
    expect(lastDateOf(rule)?.toISOString().slice(0, 10)).toBe('2100-12-31');
  });

  it('종료 없음은 null', () => {
    expect(lastDateOf(repeat('2026-09-21', 'WEEKLY'))).toBeNull();
  });
});

describe('nextDatesAfter — 고른 날짜 다음 날짜들(상세의 「다음 날짜」)', () => {
  it('고른 날짜는 빼고 그 뒤 세 개', () => {
    expect(
      iso(nextDatesAfter(repeat('2026-09-21', 'WEEKLY'), d('2026-09-28'), 3)),
    ).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
  });

  it('남은 날짜가 모자라면 있는 만큼', () => {
    expect(
      iso(
        nextDatesAfter(
          repeat('2026-09-21', 'WEEKLY', {
            repeatEndType: 'COUNT',
            repeatCount: 3,
          }),
          d('2026-09-21'),
          3,
        ),
      ),
    ).toEqual(['2026-09-28', '2026-10-05']);
  });

  it('시작 전 매주 휴일은 기준일과 멀어도 시작일부터 세 개', () => {
    expect(
      iso(nextDatesAfter(repeat('2026-11-30', 'WEEKLY'), d('2026-10-26'), 3)),
    ).toEqual(['2026-11-30', '2026-12-07', '2026-12-14']);
    expect(
      iso(nextDatesAfter(repeat('2026-11-05', 'WEEKLY'), d('2026-10-26'), 3)),
    ).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
  });

  it('매년 2월 29일처럼 드문 날짜도 찾는다', () => {
    expect(
      iso(nextDatesAfter(repeat('2024-02-29', 'YEARLY'), d('2024-02-29'), 1)),
    ).toEqual(['2028-02-29']);
  });
});

describe('holidayStateOf — 오늘(한국 날짜) 기준 시작 전 · 진행 중 · 종료', () => {
  const today = d('2026-10-26');
  it.each([
    ['시작일이 내일이면 시작 전', day('2026-10-27'), 'UPCOMING'],
    ['오늘 하루 휴일은 진행 중', day('2026-10-26'), 'ONGOING'],
    ['어제 끝난 기간은 종료', period('2026-10-20', '2026-10-25'), 'ENDED'],
    [
      '오늘 끝나는 기간은 진행 중',
      period('2026-10-20', '2026-10-26'),
      'ONGOING',
    ],
    ['끝이 없는 반복은 진행 중', repeat('2026-09-21', 'WEEKLY'), 'ONGOING'],
    [
      '마지막 반복 날짜가 지났으면 종료 — 종료일이 오늘 뒤여도',
      repeat('2026-09-21', 'WEEKLY', {
        repeatEndType: 'COUNT',
        repeatCount: 2,
      }),
      'ENDED',
    ],
  ])('%s', (_, rule, expected) => {
    expect(holidayStateOf(rule, today)).toBe(expected);
  });
});
