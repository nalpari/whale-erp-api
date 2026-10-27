import { ApiProperty } from '@nestjs/swagger';
import { PERIOD_STATE_LABELS, type PeriodState } from '../store-periods';

/** 이 사용자가 이 휴일에 할 수 있는 것과, 막혔으면 그 사유. */
export class BpHolidayActionsResponseDto {
  /** 휴일명 · 설명(시작 전이면 날짜 · 유형 · 반복 · 적용 범위까지) 수정. */
  canUpdate: boolean;
  /** 대상 · 예외 점포 더하기 · 빼기 — 일부 점포 사용자는 맡은 점포만. */
  canUpdateStores: boolean;
  /** 강제 종료(어제 날짜로 끝냄) — 시작일이 어제 이전이고 아직 끝나지 않은 휴일. */
  canTerminate: boolean;
  /** 삭제 — 시작일이 오늘 이후인 휴일. */
  canDelete: boolean;
  /** 막힌 동작의 사유. @example 끝난 휴일은 고칠 수 없습니다 */
  blockedReason: string | null;
}

/** 목록 · 캘린더의 「적용 대상」. 전체 점포면 BP 상호와 예외 점포 수, 특정 점포면 첫 점포와 나머지 수. */
export class BpHolidayTargetResponseDto {
  isAllStores: boolean;
  /** 전체 점포일 때 BP 상호. @example ㈜한강상회 */
  bpTradeName: string | null;
  /** 특정 점포일 때 그날 적용되는 첫 점포(이름순). @example 온기식당 판교점 */
  firstStoreName: string | null;
  /** 특정 점포일 때 첫 점포 말고 그날 적용되는 점포 수. */
  otherStoreCount: number;
  /** 전체 점포일 때 그날 예외인 점포 수. */
  excludedStoreCount: number;
}

/** 목록의 한 줄 — 계산한 날짜 하나에 휴일 하나. */
export class BpHolidayDateRowResponseDto {
  /** @example 2026-10-26 */
  date: string;
  bpHolidayId: number;
  /** @example 정기휴무 */
  name: string;
  /** DAY · PERIOD · REPEAT. @example REPEAT */
  holidayTypeCode: string;
  /** 반복일 때 DAILY · WEEKLY · MONTHLY · YEARLY. @example WEEKLY */
  holidayRepeatTypeCode: string | null;
  target: BpHolidayTargetResponseDto;
  /** 지난 날짜(오늘보다 앞)인가. */
  isPast: boolean;
  /** 최종 수정 — 수정 · 강제 종료 · 삭제 때 그대로 보낸다. */
  updatedAt: string;
  /** 최종 수정자 이름. */
  updatedByName: string | null;
  actions: BpHolidayActionsResponseDto;
}

/** 캘린더의 빨간 날짜 — 플랫폼 공식 휴일. 목록 행에는 넣지 않는다. */
export class BpHolidayPublicHolidayResponseDto {
  /** @example 2026-10-03 */
  holidayDate: string;
  /** @example 개천절 */
  name: string;
}

export class BpHolidayListResponseDto {
  year: number;
  month: number;
  /** 날짜순. 같은 날짜는 전체 점포 휴일 먼저, 그다음 등록 순서. */
  items: BpHolidayDateRowResponseDto[];
  total: number;
  publicHolidays: BpHolidayPublicHolidayResponseDto[];
}

/**
 * 상세의 대상 · 예외 점포 — 지우지 않은 모든 기간, 기간마다 한 줄. 같은 점포를 뺐다 다시 더했으면 두 줄이다.
 * 한 번도 적용되지 않아 지운 기간은 빠진다. 점포명 → 적용 시작일 → periodId 순.
 */
export class BpHolidayStoreResponseDto {
  /** 기간 행 ID(holiday_store_mapping_id · holiday_excluded_store_id) — 같은 점포가 기간마다 한 줄이라 화면 key 로 쓴다. */
  periodId: number;
  storeId: number;
  /** @example ST000003 */
  storeCode: string;
  /** @example 온기식당 판교점 */
  name: string;
  /** DIRECT · FRANCHISE. @example DIRECT */
  storeTypeCode: string;
  /** 점포 상태 — 폐점(CLOSED)이면 화면에 태그를 붙인다. @example OPERATING */
  storeStatusCode: string;
  /** 이 기간의 시작일. @example 2026-09-21 */
  effectiveStartDate: string;
  /** 이 기간의 종료일(점포를 뺀 날의 전날). 열린 기간이면 null — 휴일 자체가 끝났는지는 periodState 로 본다. @example 2026-10-25 */
  effectiveEndDate: string | null;
  /**
   * 오늘(한국 날짜) 기준 이 기간의 상태 — UPCOMING 적용 예정 · ACTIVE 적용 중 · ENDED 빠짐. 휴일 자체의 끝도 반영해
   * 강제 종료 · 끝난 휴일은 열린 기간도 ENDED, 시작 전 휴일의 기간은 UPCOMING 이다. 수정 양식의 「지금 열린 점포」는
   * `effectiveEndDate === null && periodState !== 'ENDED'` 인 줄이다. @example ACTIVE
   */
  @ApiProperty({
    enum: Object.keys(PERIOD_STATE_LABELS),
    enumName: 'BpHolidayPeriodState',
  })
  periodState: PeriodState;
  /** 이 사용자가 맡은 점포인가 — 일부 점포 사용자는 맡은 점포만 빼거나 더한다. */
  isManaged: boolean;
}

/** 변경 이력 한 줄. */
export class BpHolidayHistoryResponseDto {
  changeId: number;
  bpHolidayId: number;
  /** @example 정기휴무 */
  holidayName: string;
  /** @example 대상 점포 */
  field: string;
  beforeValue: string | null;
  /** @example 온기식당 판교점 추가(2026-10-26부터) */
  afterValue: string | null;
  changedAt: string;
  changedByName: string | null;
}

export class BpHolidayHistoryListResponseDto {
  items: BpHolidayHistoryResponseDto[];
  total: number;
}

export class BpHolidayDetailResponseDto {
  bpHolidayId: number;
  name: string;
  description: string | null;
  isAllStores: boolean;
  holidayTypeCode: string;
  /** @example 2026-09-21 */
  startDate: string;
  /** 하루는 시작일과 같고 반복은 null. */
  endDate: string | null;
  holidayRepeatTypeCode: string | null;
  /** NONE · UNTIL_DATE · COUNT. 반복이 아니면 null. */
  repeatEndType: string | null;
  repeatEndDate: string | null;
  repeatCount: number | null;
  /** 오늘 기준 — UPCOMING 시작 전 · ONGOING 진행 중 · ENDED 종료. */
  state: 'UPCOMING' | 'ONGOING' | 'ENDED';
  /** 특정 점포면 대상 점포, 전체 점포면 예외 점포 — 지우지 않은 모든 기간(닫힌 기간 포함), 기간마다 한 줄. */
  stores: BpHolidayStoreResponseDto[];
  /** 고른 날짜(없으면 오늘)에 이 휴일이 적용되는 점포 수. */
  appliedStoreCount: number;
  /** 반복이면 고른 날짜 다음 날짜 세 개까지. 반복이 아니면 빈 배열. */
  nextDates: string[];
  histories: BpHolidayHistoryResponseDto[];
  actions: BpHolidayActionsResponseDto;
  createdAt: string;
  createdByName: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

export class BpHolidayCreatedResponseDto {
  bpHolidayId: number;
}

/** 겹치는 날짜 하나 — 그날 그 점포에 이미 있는 휴일. */
export class BpHolidayOverlapDateResponseDto {
  /** @example 2026-11-02 */
  date: string;
  /** @example ["정기휴무"] */
  holidayNames: string[];
}

export class BpHolidayOverlapStoreResponseDto {
  storeId: number;
  storeName: string;
  /** 앞 10건. */
  dates: BpHolidayOverlapDateResponseDto[];
  /** 10건 말고 더 겹치는 날짜 수. */
  moreDateCount: number;
}

/** 겹침 요약(WHALEERP-556) — 저장은 막지 않는다. 공식 휴일과 겹치는지는 보지 않는다. */
export class BpHolidayOverlapsResponseDto {
  /** 겹치는 점포 수. */
  storeCount: number;
  /** 겹치는 (점포, 날짜) 수. */
  dateCount: number;
  stores: BpHolidayOverlapStoreResponseDto[];
}
