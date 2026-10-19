import { ConflictException } from '@nestjs/common';

/** 메뉴 「플랫폼 권한 관리」(/platform-role-groups) */
export const PLATFORM_ROLE_MENU = 'MN000214';

/**
 * 이 화면이 다루는 권한 유형 — 고정 권한(is_master — 시드된 것은 PM000001 · BM000001 · FM000001, PA 는 없다)과
 * 플랫폼 관리자 추가 권한(PA). 순서가 목록의 고정 권한 순서이고, 응답 DTO 의 enum 도 이 목록을 쓴다.
 */
export const PLATFORM_ROLE_GROUP_TYPES = ['PM', 'PA', 'BM', 'FM'] as const;
export type PlatformRoleType = (typeof PLATFORM_ROLE_GROUP_TYPES)[number];

/** 등록 API 가 만드는 유형. 고정 권한은 마이그레이션이 넣고, 여기서는 플랫폼 관리자 추가 권한만 만든다. */
export const ADDITIONAL_ROLE_TYPE = 'PA';

/** 권한명 · 설명 길이(S-JDCOAG). DB 는 길이를 CHECK 하지 않는다. */
export const ROLE_NAME_MAX = 20;
export const ROLE_DESCRIPTION_MAX = 100;

/**
 * BP · 가맹 마스터 고정 권한에서 회수하면 함께 빠지는 하위 권한 그룹의 유형. 키가 BM · FM 뿐이라, 다른 유형으로
 * 찾으면 컴파일 오류다 — 값이 없으면 Prisma 가 조건을 지워 모든 그룹을 고치게 되기 때문이다.
 */
export const CASCADE_CHILD_TYPE = { BM: 'BA', FM: 'FA' } as const;

/**
 * 권한 상세의 수정 · 삭제가 막힌 이유. API 전용 enum PlatformRoleGroupLockReason — 값 · 한글 · 순서는 이 상수
 * 하나에서 나온다(GET /enums).
 */
export const ROLE_GROUP_LOCK_REASON_LABELS = {
  FIXED_ROLE: '고정 권한',
  NO_PERMISSION: '권한 관리 메뉴 권한 없음',
  SELF_LINKED: '본인이 연결된 권한',
} as const;
export type RoleGroupLockReason = keyof typeof ROLE_GROUP_LOCK_REASON_LABELS;
export const ROLE_GROUP_LOCK_REASONS = Object.keys(
  ROLE_GROUP_LOCK_REASON_LABELS,
) as readonly RoleGroupLockReason[];

export const NOT_FOUND = '권한을 찾을 수 없습니다';
export const NAME_TAKEN = '같은 이름의 권한이 있습니다';
export const SELF_LINKED = '본인이 연결된 권한이라 고칠 수 없습니다';
export const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요';

/**
 * 다음 권한 코드 — 유형 + 6자리 순번. 지운 그룹까지 포함한 마지막 코드의 다음이라 지운 번호를 다시 쓰지
 * 않는다(PL-EIMSQF). 6자리를 다 쓰면 더 만들 수 없다.
 */
export function nextRoleCode(roleType: string, last: string | null): string {
  const next = (last ? Number(last.slice(2)) : 0) + 1;
  if (next > 999_999)
    throw new ConflictException('권한 코드를 더 만들 수 없습니다');
  return `${roleType}${String(next).padStart(6, '0')}`;
}

/** 관리자 변경 이력(admin_change_histories 「사용자 권한」)의 권한 표기. 플랫폼 관리자 관리와 같다. @example 고객지원 담당 PA000002 */
export function roleGroupLabel(group: {
  name: string;
  roleCode: string;
}): string {
  return `${group.name} ${group.roleCode}`;
}

/** 목록 순서 — 고정 권한 PM · PA · BM · FM, 그다음 추가 권한을 코드 순으로. */
export function sortPlatformRoleGroups<
  T extends { roleCode: string; roleTypeCode: string; isMaster: boolean },
>(rows: T[]): T[] {
  const order: readonly string[] = PLATFORM_ROLE_GROUP_TYPES;
  const rank = (row: T) =>
    row.isMaster ? order.indexOf(row.roleTypeCode) : order.length;
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.roleCode.localeCompare(b.roleCode),
  );
}
