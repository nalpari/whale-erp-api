// 조회 · 저장이 함께 쓰는 bp_holidays 읽기 모양과 범위 조건.
import { Prisma } from '@prisma/client';
import type { HolidayCaller, ManagedHoliday } from './bp-holiday-access';
import { STORE_SELECT } from './holiday-application';

/** 상세 · 저장이 읽는 휴일 — 규칙 칸과 지우지 않은 대상 · 예외 점포 기간. 점포는 이름순. */
export const HOLIDAY_SELECT = {
  bpHolidayId: true,
  name: true,
  description: true,
  isAllStores: true,
  holidayTypeCode: true,
  startDate: true,
  endDate: true,
  holidayRepeatTypeCode: true,
  repeatEndType: true,
  repeatEndDate: true,
  repeatCount: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  storeMappings: {
    where: { isDeleted: false },
    select: {
      holidayStoreMappingId: true,
      storeId: true,
      effectiveStartDate: true,
      effectiveEndDate: true,
      store: { select: STORE_SELECT },
    },
    orderBy: [{ store: { name: 'asc' } }, { storeId: 'asc' }],
  },
  excludedStores: {
    where: { isDeleted: false },
    select: {
      holidayExcludedStoreId: true,
      storeId: true,
      effectiveStartDate: true,
      effectiveEndDate: true,
      store: { select: STORE_SELECT },
    },
    orderBy: [{ store: { name: 'asc' } }, { storeId: 'asc' }],
  },
} satisfies Prisma.BpHolidaySelect;

export type HolidayRow = Prisma.BpHolidayGetPayload<{
  select: typeof HOLIDAY_SELECT;
}>;

/**
 * 이 사용자가 보는 휴일 — 그 BP 의 전체 점포 휴일과, 맡은 점포가 대상(지난 기간 포함)인 특정 점포 휴일
 * (WHALEERP-553 · 565). 날짜별로 맡은 점포에 적용되는지는 계산한 뒤 다시 거른다.
 */
export function visibleWhere(
  caller: HolidayCaller,
): Prisma.BpHolidayWhereInput {
  return {
    bpCodeId: caller.bpCodeId,
    ...(caller.storeScope && {
      OR: [
        { isAllStores: true },
        {
          storeMappings: {
            some: { isDeleted: false, storeId: { in: [...caller.storeScope] } },
          },
        },
      ],
    }),
  };
}

/** 지금 열린(종료일 없는) 기간 — 대상 · 예외 점포의 「현재」 목록이다. */
export const openPeriodsOf = <T extends { effectiveEndDate: Date | null }>(
  periods: readonly T[],
): T[] => periods.filter((p) => p.effectiveEndDate === null);

/** 권한 판정용 — 열린 대상 점포 중 지우지 않은 점포. */
export function managedOf(row: HolidayRow): ManagedHoliday {
  return {
    ...row,
    openStoreIds: openPeriodsOf(row.storeMappings)
      .filter((p) => !p.store.isDeleted)
      .map((p) => p.storeId),
  };
}
