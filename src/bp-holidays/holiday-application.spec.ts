import { appliedStoresOn, type HolidayStore } from './holiday-application';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const store = (
  storeId: number,
  over: Partial<HolidayStore> = {},
): HolidayStore => ({
  storeId,
  storeCode: `ST00000${storeId}`,
  name: `점포${storeId}`,
  storeTypeCode: 'DIRECT',
  storeStatusCode: 'OPERATING',
  closedDate: null,
  // 한국 2026-09-01 09:00
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  isDeleted: false,
  ...over,
});

const period = (
  storeId: number,
  start: string,
  end: string | null = null,
  s: HolidayStore = store(storeId),
) => ({
  storeId,
  effectiveStartDate: d(start),
  effectiveEndDate: end ? d(end) : null,
  store: s,
});

describe('appliedStoresOn — 그날 이 휴일이 적용되는 점포', () => {
  it('특정 점포 휴일은 그날 기간 안인 대상 점포', () => {
    const holiday = {
      isAllStores: false,
      storeMappings: [
        period(1, '2026-10-01', '2026-10-10'),
        period(2, '2026-10-11'),
      ],
      excludedStores: [],
    };
    expect(
      appliedStoresOn(holiday, [], d('2026-10-10')).map((s) => s.storeId),
    ).toEqual([1]);
    expect(
      appliedStoresOn(holiday, [], d('2026-10-11')).map((s) => s.storeId),
    ).toEqual([2]);
  });

  it('폐점한 점포는 폐점일 다음 날부터 빠진다', () => {
    const closed = store(1, { closedDate: d('2026-10-15') });
    const holiday = {
      isAllStores: false,
      storeMappings: [period(1, '2026-10-01', null, closed)],
      excludedStores: [],
    };
    expect(appliedStoresOn(holiday, [], d('2026-10-15'))).toHaveLength(1);
    expect(appliedStoresOn(holiday, [], d('2026-10-16'))).toHaveLength(0);
  });

  it('지운 점포는 적용되지 않는다', () => {
    const holiday = {
      isAllStores: false,
      storeMappings: [
        period(1, '2026-10-01', null, store(1, { isDeleted: true })),
      ],
      excludedStores: [],
    };
    expect(appliedStoresOn(holiday, [], d('2026-10-20'))).toHaveLength(0);
  });

  it('전체 점포 휴일은 BP 점포 중 그날 예외가 아닌 점포 — 점포 등록일(한국) 전에는 적용되지 않는다', () => {
    const late = store(3, { createdAt: new Date('2026-10-19T15:30:00.000Z') }); // 한국 10-20
    const holiday = {
      isAllStores: true,
      storeMappings: [],
      excludedStores: [period(2, '2026-10-10', '2026-10-19')],
    };
    const bpStores = [store(1), store(2), late];
    expect(
      appliedStoresOn(holiday, bpStores, d('2026-10-19')).map((s) => s.storeId),
    ).toEqual([1]);
    expect(
      appliedStoresOn(holiday, bpStores, d('2026-10-20')).map((s) => s.storeId),
    ).toEqual([1, 2, 3]);
  });
});
