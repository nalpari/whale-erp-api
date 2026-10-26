import { actionsOf, type HolidayCaller } from './bp-holiday-access';
import { managedOf, type HolidayRow } from './bp-holiday-rows';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const store = (storeId: number, isDeleted = false) => ({
  storeId,
  storeCode: `ST0000${storeId}`,
  name: `점포${storeId}`,
  storeTypeCode: 'DIRECT',
  storeStatusCode: 'NOT_OPERATING',
  closedDate: null,
  createdAt: d('2026-01-01'),
  isDeleted,
});

const row = (stores: ReturnType<typeof store>[]): HolidayRow => ({
  bpHolidayId: 1,
  name: '휴일',
  description: null,
  isAllStores: false,
  holidayTypeCode: 'REPEAT',
  startDate: d('2026-09-21'),
  endDate: null,
  holidayRepeatTypeCode: 'WEEKLY',
  repeatEndType: 'NONE',
  repeatEndDate: null,
  repeatCount: null,
  createdAt: d('2026-09-01'),
  createdBy: 1,
  updatedAt: d('2026-09-01'),
  updatedBy: 1,
  storeMappings: stores.map((s, i) => ({
    holidayStoreMappingId: i + 1,
    storeId: s.storeId,
    effectiveStartDate: d('2026-09-21'),
    effectiveEndDate: null,
    store: s,
  })),
  excludedStores: [],
});

const limited: HolidayCaller = {
  adminAccountId: 1,
  bpCodeId: 7,
  manageAll: false,
  storeScope: new Set([10]),
  rights: { create: true, update: true, delete: true },
};

describe('managedOf — 권한 판정에 쓰는 열린 대상 점포', () => {
  it('지운 점포는 열린 대상에서 뺀다 — 범위 밖 점포가 지워졌으면 맡은 사용자가 휴일 전체를 다룬다', () => {
    const r = row([store(10), store(11, true)]);
    expect(managedOf(r).openStoreIds).toEqual([10]);
    expect(actionsOf(limited, managedOf(r), d('2026-10-26'))).toMatchObject({
      canUpdate: true,
      canTerminate: true,
    });
  });

  it('범위 밖 점포가 살아 있으면 전체를 다루지 못한다', () => {
    expect(
      actionsOf(
        limited,
        managedOf(row([store(10), store(11)])),
        d('2026-10-26'),
      ),
    ).toMatchObject({ canUpdate: false, canTerminate: false });
  });
});
