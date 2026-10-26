// BP 휴일을 누가 어디까지 다루는가(WHALEERP-565, CONFIG-10)와, 휴일 상태에 따라 무엇을 할 수 있는가
// (BP 휴일 변경 · 종료 정책, 2026-10-26). 메뉴 권한 자체는 가드가 경로마다 보고, 여기서는 그 위의 규칙을 본다.
import { addDays } from '../staff-members/kst-date';
import { holidayStateOf, type HolidayRule } from './holiday-dates';

/** BP 휴일 관리 메뉴(MN000015)의 등록 · 수정 · 삭제 권한. */
export interface HolidayRights {
  create: boolean;
  update: boolean;
  delete: boolean;
}

export interface HolidayCaller {
  adminAccountId: number;
  /** 다루는 BP — 플랫폼 계정은 상단에서 고른 BP, 그 밖에는 소속 BP. */
  bpCodeId: number;
  /** 전체 점포 휴일과 예외 점포를 다루는가 — 플랫폼 계정 · BP 마스터 · 전체 점포 BP 관리자. */
  manageAll: boolean;
  /** 다루는 점포. null 이면 그 BP 의 모든 점포. */
  storeScope: ReadonlySet<number> | null;
  rights: HolidayRights;
}

/** 휴일 행에서 판정에 쓰는 것 — 규칙과, 지금 열린 대상 점포(특정 점포 휴일). */
export interface ManagedHoliday extends HolidayRule {
  isAllStores: boolean;
  openStoreIds: readonly number[];
}

export interface HolidayActions {
  /** 휴일명 · 설명(시작 전이면 날짜 · 유형 · 반복 · 적용 범위까지)을 고친다. */
  canUpdate: boolean;
  /** 대상 · 예외 점포를 더하거나 뺀다 — 일부 점포 사용자는 맡은 점포만. */
  canUpdateStores: boolean;
  /** 어제 날짜로 끝낸다 — 시작일이 어제 이전이고 아직 끝나지 않은 휴일. */
  canTerminate: boolean;
  /** 지운다 — 시작일이 오늘 이후라 지난 날짜가 없는 휴일. */
  canDelete: boolean;
  /** 막힌 동작이 있을 때 화면에 보일 사유. */
  blockedReason: string | null;
}

export const ENDED_REASON = '끝난 휴일은 고칠 수 없습니다';
export const SHARED_REASON =
  '맡지 않은 점포가 함께 묶인 휴일입니다 — 맡은 점포만 빼거나 더할 수 있습니다';
export const TODAY_START_REASON =
  '오늘 시작한 휴일은 강제 종료할 수 없습니다 — 삭제해 주세요';
export const ALL_STORES_REASON =
  '전체 점포 휴일은 BP 마스터 · 전체 점포 BP 관리자만 고칠 수 있습니다';

/** 본사 역할 중 전체 점포 휴일을 다루는 것. 가맹 역할(FM · FA)은 전체 점포여도 다루지 않는다. */
const HQ_ROLES = new Set(['BM', 'BA']);

export function callerOf(account: {
  adminAccountId: number;
  targetBpCodeId: number;
  roleTypeCode: string;
  isPlatform: boolean;
  isAllStores: boolean;
  mappedStoreIds: readonly number[];
  rights: HolidayRights;
}): HolidayCaller {
  const allStores = account.isPlatform || account.isAllStores;
  return {
    adminAccountId: account.adminAccountId,
    bpCodeId: account.targetBpCodeId,
    manageAll:
      account.isPlatform ||
      account.roleTypeCode === 'BM' ||
      (HQ_ROLES.has(account.roleTypeCode) && account.isAllStores),
    storeScope: allStores ? null : new Set(account.mappedStoreIds),
    rights: account.rights,
  };
}

export function inScope(caller: HolidayCaller, storeId: number): boolean {
  return caller.storeScope === null || caller.storeScope.has(storeId);
}

/** 이 휴일 전체를 다루는가 — 전체 점포 휴일이면 manageAll, 특정 점포 휴일이면 열린 대상 점포가 모두 범위 안. */
export function managesWhole(
  caller: HolidayCaller,
  holiday: Pick<ManagedHoliday, 'isAllStores' | 'openStoreIds'>,
): boolean {
  return holiday.isAllStores
    ? caller.manageAll
    : holiday.openStoreIds.every((id) => inScope(caller, id));
}

export function actionsOf(
  caller: HolidayCaller,
  holiday: ManagedHoliday,
  today: Date,
): HolidayActions {
  if (holidayStateOf(holiday, today) === 'ENDED')
    return {
      canUpdate: false,
      canUpdateStores: false,
      canTerminate: false,
      canDelete: false,
      blockedReason: ENDED_REASON,
    };
  const whole = managesWhole(caller, holiday);
  // 일부 점포 사용자는 전체 점포 휴일의 예외 점포를 바꾸지 못하고, 특정 점포 휴일은 맡은 점포만 바꾼다.
  const storesEditable = holiday.isAllStores ? caller.manageAll : true;
  const startedBeforeToday = holiday.startDate <= addDays(today, -1);
  return {
    canUpdate: caller.rights.update && whole,
    canUpdateStores: caller.rights.update && storesEditable,
    canTerminate: caller.rights.delete && whole && startedBeforeToday,
    canDelete: caller.rights.delete && whole && !startedBeforeToday,
    blockedReason: !whole
      ? holiday.isAllStores
        ? ALL_STORES_REASON
        : SHARED_REASON
      : // 오늘 시작한 휴일은 어제로 끝낼 수 없다(시작일보다 앞) — 삭제를 안내한다(정책 3).
        holiday.startDate.getTime() === today.getTime()
        ? TODAY_START_REASON
        : null,
  };
}
