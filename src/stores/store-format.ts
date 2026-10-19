import type { ContractStatus } from '@prisma/client';
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
export type FloorType = (typeof FLOOR_TYPES)[number];

/** 살아 있는 점포 — 목록 기본값이고, 사업자등록번호가 이 점포들끼리 고유하다. */
export const LIVE_STORE_STATUSES = [
  'NOT_OPERATING',
  'OPERATING',
] as const satisfies readonly StoreStatus[];

/** 목록 한 쪽 건수 — 20 · 50 · 100(STORE-4). */
export const STORE_PAGE_SIZES = [20, 50, 100] as const;
export type StorePageSize = (typeof STORE_PAGE_SIZES)[number];

// 세 공통코드는 플랫폼고정이라 운영 중에 바뀌지 않는다. satisfies 로 값이 늘면 라벨 누락을 컴파일러가 잡는다.
const STATUS_LABELS = {
  NOT_OPERATING: '미운영',
  OPERATING: '운영',
  CLOSED: '폐점',
} satisfies Record<StoreStatus, string>;

const STORE_TYPE_LABELS = {
  DIRECT: '직영점포',
  FRANCHISE: '가맹점포',
} satisfies Record<StoreType, string>;

const FLOOR_LABELS = {
  GROUND: '지상',
  BASEMENT: '지하',
} satisfies Record<FloorType, string>;

/**
 * 코드의 한글. DB 칸에 값 제약이 없어 모르는 값이 오면 그대로 보인다. hasOwn 으로 본다 — 'toString' 같은
 * 값이 Object.prototype 의 함수를 집어 오지 않게.
 */
function labelOr(
  labels: Readonly<Record<string, string>>,
  code: string,
): string {
  return Object.hasOwn(labels, code) ? labels[code] : code;
}

/** 점포 상태의 한글. */
export function statusLabel(code: string): string {
  return labelOr(STATUS_LABELS, code);
}

/** 점포 유형의 한글. */
export function storeTypeLabel(code: string): string {
  return labelOr(STORE_TYPE_LABELS, code);
}

/** 플랫폼 계정이 될 수 있는 권한 유형. 소속 BP 도 플랫폼 BP 여야 플랫폼 계정이다(StoreManagementService.loadCaller). */
export const PLATFORM_ROLE_TYPES = ['PM', 'PA'];

/** 가맹 역할은 메뉴 권한과 상관없이 점포를 등록하지 못한다(F-MOQKGY). */
export const FRANCHISE_ROLE_TYPES = ['FM', 'FA'];

/**
 * 폐점 · 삭제를 막는 근로계약 — 거부 · 만료 · 종료되지 않은 것. 체결 전(임시저장 · 발송 대기 · 서명 대기 · 수정 요청)과
 * 체결 완료가 남아 있으면 그 점포에서 일할 사람이 있다는 뜻이다.
 */
export const IN_PROGRESS_CONTRACT_STATUSES = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED', // 3팀 근로계약 수정 요청(2026-10-16) — 날인 전 진행 중
  'SIGNED',
] as const satisfies readonly ContractStatus[];

/** 상태가 이 방향으로 바뀔 수 있는가. 그대로 두는 것도 된다 — 폐점만은 그대로 저장하는 것도 안 된다(조회만). */
export function canTransition(from: string, to: StoreStatus): boolean {
  if (from === 'CLOSED') return false;
  if (from === to) return true;
  if (from === 'NOT_OPERATING') return to === 'OPERATING' || to === 'CLOSED';
  if (from === 'OPERATING') return to === 'CLOSED';
  return false;
}

/**
 * 운영으로 바꾸거나 운영인 채 저장하는 데 모자란 것(STORE-2). API 전용 enum StoreOperationRequirement —
 * 값 · 한글 · 순서는 이 상수 하나에서 나온다(GET /enums, 저장 거절 문구).
 */
export const OPERATION_REQUIREMENT_LABELS = {
  BUSINESS_VERIFICATION: '사업자정보 인증',
  COORDINATES: '좌표(위도 · 경도)',
  BP_INACTIVE: '소속 BP 사용',
} as const;
export type OperationRequirement = keyof typeof OPERATION_REQUIREMENT_LABELS;
export const OPERATION_REQUIREMENTS = Object.keys(
  OPERATION_REQUIREMENT_LABELS,
) as readonly OperationRequirement[];

/** 저장 전 사업자 인증 결과. API 전용 enum StoreBusinessVerificationResult. */
export const BUSINESS_VERIFICATION_RESULT_LABELS = {
  VERIFIED: '인증됨',
  UNVERIFIABLE: '확인 불가',
  DUPLICATE: '번호 중복',
} as const;
export type BusinessVerificationResult =
  keyof typeof BUSINESS_VERIFICATION_RESULT_LABELS;
export const BUSINESS_VERIFICATION_RESULTS = Object.keys(
  BUSINESS_VERIFICATION_RESULT_LABELS,
) as readonly BusinessVerificationResult[];

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

/** 목록 카드의 「지역」 — 기본주소의 앞 두 마디(시 · 도와 시 · 군 · 구). 칸이 따로 없어 주소에서 뽑는다. */
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
    floor.floorTypeCode && labelOr(FLOOR_LABELS, floor.floorTypeCode),
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
