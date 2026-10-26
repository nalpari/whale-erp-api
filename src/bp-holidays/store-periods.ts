// 대상 점포(holiday_store_mappings) · 예외 점포(holiday_excluded_stores)는 한 행이 한 적용 기간이다.
// 점포를 더하면 오늘부터, 빼면 어제까지 — 지난 날짜에 어느 점포가 쉬었는지는 바뀌지 않는다(BP 휴일 변경 · 종료 정책).
import { addDays } from '../staff-members/kst-date';

export interface Period {
  effectiveStartDate: Date;
  effectiveEndDate: Date | null;
}

/** 아직 열려 있는(종료일 없는) 기간 행. */
export interface OpenPeriod {
  id: number;
  storeId: number;
  effectiveStartDate: Date;
}

export interface PeriodPlan {
  /** 새 기간 — 오늘(시작 전 휴일이면 휴일 시작일)부터. */
  add: { storeId: number; effectiveStartDate: Date }[];
  /** 적용된 날이 있는 기간은 어제로 닫는다. */
  close: { id: number; storeId: number; effectiveEndDate: Date }[];
  /** 적용된 날이 없는 기간(오늘 · 앞으로 시작)은 지운다(is_deleted). */
  drop: { id: number; storeId: number }[];
}

/**
 * 열린 기간과 원하는 점포 목록의 차이. 그대로인 점포는 건드리지 않는다 — 기간이 이어진다.
 * holidayStart 는 휴일 시작일이다. 시작 전 휴일에 더한 점포는 휴일 시작일부터라 「기간 없이 바로」 바뀐다.
 */
export function planStorePeriods(
  open: readonly OpenPeriod[],
  desiredStoreIds: readonly number[],
  today: Date,
  holidayStart: Date,
): PeriodPlan {
  const desired = new Set(desiredStoreIds);
  const current = new Set(open.map((p) => p.storeId));
  const start = holidayStart > today ? holidayStart : today;
  const yesterday = addDays(today, -1);
  const plan: PeriodPlan = { add: [], close: [], drop: [] };
  for (const storeId of desired)
    if (!current.has(storeId))
      plan.add.push({ storeId, effectiveStartDate: start });
  for (const p of open) {
    if (desired.has(p.storeId)) continue;
    if (p.effectiveStartDate >= today)
      plan.drop.push({ id: p.id, storeId: p.storeId });
    else
      plan.close.push({
        id: p.id,
        storeId: p.storeId,
        effectiveEndDate: yesterday,
      });
  }
  return plan;
}

/** 그 날짜가 기간 안인가(양 끝 포함). */
export function appliesOn(period: Period, date: Date): boolean {
  return (
    period.effectiveStartDate <= date &&
    (period.effectiveEndDate === null || date <= period.effectiveEndDate)
  );
}
