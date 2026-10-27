import { API_ENUMS } from '../enums/api-enums';
import { appliesOn, periodStateOf, planStorePeriods } from './store-periods';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = d('2026-10-26');

describe('planStorePeriods — 점포 목록 변경을 기간 행 변경으로', () => {
  const open = [
    { id: 1, storeId: 10, effectiveStartDate: d('2026-10-01') },
    { id: 2, storeId: 20, effectiveStartDate: d('2026-10-26') },
  ];

  it('더한 점포는 오늘부터, 그대로인 점포는 건드리지 않는다', () => {
    expect(
      planStorePeriods(open, [10, 20, 30], today, d('2026-10-01')),
    ).toEqual({
      add: [{ storeId: 30, effectiveStartDate: today }],
      close: [],
      drop: [],
    });
  });

  it('뺀 점포는 어제까지 — 오늘 더한 점포는 적용된 날이 없어 지운다', () => {
    expect(planStorePeriods(open, [], today, d('2026-10-01'))).toEqual({
      add: [],
      close: [{ id: 1, storeId: 10, effectiveEndDate: d('2026-10-25') }],
      drop: [{ id: 2, storeId: 20 }],
    });
  });

  it('시작 전 휴일은 휴일 시작일부터 더하고, 빼면 지운다(기간 없이 바로)', () => {
    const upcoming = [
      { id: 3, storeId: 10, effectiveStartDate: d('2026-11-03') },
    ];
    expect(planStorePeriods(upcoming, [20], today, d('2026-11-03'))).toEqual({
      add: [{ storeId: 20, effectiveStartDate: d('2026-11-03') }],
      close: [],
      drop: [{ id: 3, storeId: 10 }],
    });
  });

  it('같은 점포를 두 번 보내도 한 번만 더한다', () => {
    expect(planStorePeriods([], [30, 30], today, d('2026-10-01')).add).toEqual([
      { storeId: 30, effectiveStartDate: today },
    ]);
  });
});

describe('appliesOn — 그 날짜가 기간 안인가', () => {
  const period = {
    effectiveStartDate: d('2026-10-05'),
    effectiveEndDate: d('2026-10-10'),
  };
  it.each([
    ['2026-10-04', false],
    ['2026-10-05', true],
    ['2026-10-10', true],
    ['2026-10-11', false],
  ])('%s → %s', (date, expected) => {
    expect(appliesOn(period, d(date))).toBe(expected);
  });

  it('종료일이 없으면 시작일부터 계속', () => {
    expect(
      appliesOn(
        { effectiveStartDate: d('2026-10-05'), effectiveEndDate: null },
        d('2099-01-01'),
      ),
    ).toBe(true);
  });
});

describe('BpHolidayPeriodState — 화면 한글은 GET /enums 로', () => {
  it('API 전용 enum 으로 등록돼 있다', () => {
    expect(API_ENUMS.BpHolidayPeriodState).toEqual([
      ['UPCOMING', '적용 예정'],
      ['ACTIVE', '적용 중'],
      ['ENDED', '빠짐'],
    ]);
  });
});

describe('periodStateOf — 오늘 기준 이 기간의 상태(휴일 자체의 끝 포함)', () => {
  const period = (start: string, end: string | null = null) => ({
    effectiveStartDate: d(start),
    effectiveEndDate: end ? d(end) : null,
  });
  // 세 번째 값은 휴일의 마지막 날짜 — null 이면 끝이 없다
  it.each([
    ['시작 전 휴일의 기간은 적용 예정', period('2026-11-02'), null, 'UPCOMING'],
    ['오늘 더한 점포는 적용 중', period('2026-10-26'), null, 'ACTIVE'],
    ['열린 기간은 적용 중', period('2026-09-21'), null, 'ACTIVE'],
    [
      '어제로 닫힌 기간은 빠짐',
      period('2026-09-21', '2026-10-25'),
      null,
      'ENDED',
    ],
    [
      '오늘까지인 기간은 적용 중',
      period('2026-09-21', '2026-10-26'),
      null,
      'ACTIVE',
    ],
    // 강제 종료 · 끝난 휴일은 열린 기간도 빠짐
    [
      '휴일이 어제 끝났으면 열린 기간도 빠짐',
      period('2026-09-21'),
      '2026-10-25',
      'ENDED',
    ],
    [
      '휴일이 오늘 끝나면 열린 기간은 적용 중',
      period('2026-09-21'),
      '2026-10-26',
      'ACTIVE',
    ],
    [
      '휴일이 앞으로 끝나도 열린 기간은 적용 중',
      period('2026-09-21'),
      '2026-12-31',
      'ACTIVE',
    ],
  ] as const)('%s', (_, p, holidayLast, expected) => {
    expect(periodStateOf(p, holidayLast ? d(holidayLast) : null, today)).toBe(
      expected,
    );
  });
});
