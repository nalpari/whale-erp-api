import { addMonths, kstToday } from '../staff-members/kst-date';

/** 메뉴 「점포 정보 관리」(/stores) */
export const STORE_MENU = 'MN000002';

/** 공통코드 STORE_STATUS — 미운영 · 운영 · 폐점. 이 순서로만 바뀐다(미운영 → 폐점은 바로 가능). */
export const STORE_STATUSES = ['NOT_OPERATING', 'OPERATING', 'CLOSED'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** 공통코드 STORE_TYPE — 직영점포 · 가맹점포. 등록 뒤 바꾸지 않는다. */
export const STORE_TYPES = ['DIRECT', 'FRANCHISE'] as const;
export type StoreType = (typeof STORE_TYPES)[number];

/** 공통코드 FLOOR_TYPE — 지상 · 지하. */
export const FLOOR_TYPES = ['GROUND', 'BASEMENT'] as const;

/** 목록 한 쪽 건수 — 20 · 50 · 100(STORE-4). */
export const STORE_PAGE_SIZES = [20, 50, 100];

export const STATUS_LABEL: Record<string, string> = {
  NOT_OPERATING: '미운영',
  OPERATING: '운영',
  CLOSED: '폐점',
};

const FLOOR_LABEL: Record<string, string> = {
  GROUND: '지상',
  BASEMENT: '지하',
};

/** 플랫폼 계정은 모든 BP 의 점포를 다룬다. */
export const PLATFORM_ROLE_TYPES = ['PM', 'PA'];

/** 가맹 역할은 메뉴 권한과 상관없이 점포를 등록하지 못한다(F-MOQKGY). */
export const FRANCHISE_ROLE_TYPES = ['FM', 'FA'];

/**
 * 폐점 · 삭제를 막는 근로계약 — 거부 · 만료 · 종료되지 않은 것. 체결 전(임시저장 · 발송 대기 · 서명 대기)과
 * 체결 완료가 남아 있으면 그 점포에서 일할 사람이 있다는 뜻이다.
 */
export const IN_PROGRESS_CONTRACT_STATUSES = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'SIGNED',
] as const;

/** 상태가 이 방향으로 바뀔 수 있는가. 그대로 두는 것도 된다. 폐점에서는 어디로도 가지 않는다. */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'NOT_OPERATING') return to === 'OPERATING' || to === 'CLOSED';
  if (from === 'OPERATING') return to === 'CLOSED';
  return false;
}

/** 운영으로 바꾸거나 운영인 채 저장하는 데 모자란 것. 비어 있으면 운영할 수 있다(STORE-2). */
export type OperationRequirement =
  'BUSINESS_VERIFICATION' | 'COORDINATES' | 'BP_INACTIVE';

export function missingForOperation(store: {
  bizRegistrationNumber: string | null;
  latitude: unknown;
  longitude: unknown;
  bpAccountStatusCode: string;
}): OperationRequirement[] {
  const missing: OperationRequirement[] = [];
  if (!store.bizRegistrationNumber) missing.push('BUSINESS_VERIFICATION');
  if (store.latitude == null || store.longitude == null)
    missing.push('COORDINATES');
  if (store.bpAccountStatusCode !== 'ACTIVE') missing.push('BP_INACTIVE');
  return missing;
}

/** 목록 카드의 「지역」 — 기본주소의 앞 두 마디(시 · 군 · 구). 칸이 따로 없어 주소에서 뽑는다. */
export function regionOf(address: string | null): string | null {
  const words = address?.trim().split(/\s+/).filter(Boolean) ?? [];
  return words.length ? words.slice(0, 2).join(' ') : null;
}

/** 변경 이력 보존 기한 — 변경일(한국 날짜) + 5년. */
export function retainEndDate(now: Date = new Date()): Date {
  return addMonths(kstToday(now), 60);
}

/** 사업자등록번호는 숫자만 저장하고 숫자만 견준다 — 하이픈을 넣어 보내도 같은 번호다. */
export const digitsOnly = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/[^0-9]/g, '') : value;

/** 층별 정보 한 줄의 이력 표기. @example 지상 1층 18평 · 52.5㎡ · 24석 */
export function floorLabel(floor: {
  floorTypeCode: string | null;
  floorNumber: number | null;
  floorAreaPyeong: unknown;
  floorAreaSqm: unknown;
  seatCount: number | null;
}): string {
  const where = [
    floor.floorTypeCode && FLOOR_LABEL[floor.floorTypeCode],
    floor.floorNumber != null && `${floor.floorNumber}층`,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    where,
    floor.floorAreaPyeong != null && `${Number(floor.floorAreaPyeong)}평`,
    floor.floorAreaSqm != null && `${Number(floor.floorAreaSqm)}㎡`,
    floor.seatCount != null && `${floor.seatCount}석`,
  ]
    .filter(Boolean)
    .join(' · ');
}
