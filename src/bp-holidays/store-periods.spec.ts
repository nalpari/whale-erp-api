import { appliesOn, planStorePeriods } from './store-periods';

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
