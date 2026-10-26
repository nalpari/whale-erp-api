// 휴일이 그날 어느 점포에 적용되는가(WHALEERP-552). 날짜는 @db.Date 와 같은 UTC 자정 Date 다.
import { kstToday } from '../staff-members/kst-date';
import { appliesOn, type Period } from './store-periods';

/** 판정에 쓰는 점포 칸 — 상세의 점포 표도 이것으로 그린다. */
export interface HolidayStore {
  storeId: number;
  storeCode: string;
  name: string;
  storeTypeCode: string;
  storeStatusCode: string;
  closedDate: Date | null;
  createdAt: Date;
  isDeleted: boolean;
}

export interface StorePeriodRow extends Period {
  storeId: number;
  store: HolidayStore;
}

export interface HolidayStores {
  isAllStores: boolean;
  /** 지우지 않은 대상 점포 기간. */
  storeMappings: readonly StorePeriodRow[];
  /** 지우지 않은 예외 점포 기간. */
  excludedStores: readonly Pick<StorePeriodRow, 'storeId' | keyof Period>[];
}

export const STORE_SELECT = {
  storeId: true,
  storeCode: true,
  name: true,
  storeTypeCode: true,
  storeStatusCode: true,
  closedDate: true,
  createdAt: true,
  isDeleted: true,
} as const;

/**
 * 그날 문을 연 점포인가 — 지우지 않았고, 폐점했으면 폐점일까지(다음 날부터 빠진다). fromCreation 이면 점포 등록일
 * (한국 날짜)부터다 — 전체 점포 휴일은 나중에 생긴 점포에 그 등록일부터 적용한다(BP 휴일 변경 · 종료 정책).
 */
export function storeOpenOn(
  store: HolidayStore,
  date: Date,
  fromCreation: boolean,
): boolean {
  if (store.isDeleted) return false;
  if (store.closedDate && date > store.closedDate) return false;
  return !fromCreation || kstToday(store.createdAt) <= date;
}

/**
 * 그날 이 휴일이 적용되는 점포. 전체 점포 휴일은 bpStores(그 BP 의 점포) 중 그날 예외가 아닌 점포, 특정 점포
 * 휴일은 그날 기간 안인 대상 점포다. 점포 순서는 bpStores · 대상 기간의 순서를 따른다.
 */
export function appliedStoresOn(
  holiday: HolidayStores,
  bpStores: readonly HolidayStore[],
  date: Date,
): HolidayStore[] {
  if (holiday.isAllStores) {
    const excluded = new Set(
      holiday.excludedStores
        .filter((p) => appliesOn(p, date))
        .map((p) => p.storeId),
    );
    return bpStores.filter(
      (s) => !excluded.has(s.storeId) && storeOpenOn(s, date, true),
    );
  }
  return holiday.storeMappings
    .filter((p) => appliesOn(p, date) && storeOpenOn(p.store, date, false))
    .map((p) => p.store);
}
