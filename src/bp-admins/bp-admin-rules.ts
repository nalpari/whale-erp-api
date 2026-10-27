import { BadRequestException, ForbiddenException } from '@nestjs/common';

/** 이 화면이 다루는 권한 유형 — BP 관리자 · 가맹 마스터 · 가맹 관리자. BP 마스터는 플랫폼의 BP 관리 몫이다. */
export const BP_ADMIN_ROLES = ['BA', 'FM', 'FA'] as const;
export type BpAdminRole = (typeof BP_ADMIN_ROLES)[number];

/** 호출자의 쪽 — 본사(BP 마스터 · BP 관리자 · 플랫폼 사용자) · 가맹 마스터 · 가맹 관리자. */
export type BpAdminSide = 'HQ' | 'FM' | 'FA';

/** 호출자. 서비스가 DB 에서 읽어 만든다. 플랫폼 사용자는 대상 BP 의 전체 점포를 맡은 것으로 본다(2026-10-23). */
export interface BpAdminCaller {
  adminAccountId: number;
  side: BpAdminSide;
  isAllStores: boolean;
  /** 관리 점포. 전체 점포면 대상 BP 의 지우지 않은 점포 전부 */
  storeIds: number[];
}

/** 다루는 계정. 가맹 관리자의 연결 가맹 마스터는 그 권한 그룹의 관리계정이다. */
export interface BpAdminTarget {
  adminAccountId: number;
  roleTypeCode: BpAdminRole;
  isAllStores: boolean;
  storeIds: number[];
  franchiseMasterId: number | null;
}

export interface BpAdminActions {
  isSelf: boolean;
  canUpdate: boolean;
  canResetPassword: boolean;
  canChangeScope: boolean;
  canChangeRoleGroup: boolean;
}

export const OUT_OF_SCOPE = '점포 범위를 벗어나 저장하지 않았습니다';

/**
 * 권한 유형과 소속으로 쪽을 정한다. 플랫폼 BP 의 PM · PA 만 플랫폼 사용자다 — 고객 BP 에 붙은 PM · PA,
 * 플랫폼 BP 에 붙은 BP 쪽 유형은 잘못 붙은 역할이라 null(403).
 */
export function sideOf(
  roleTypeCode: string,
  isPlatformBp: boolean,
): BpAdminSide | null {
  if (isPlatformBp) return ['PM', 'PA'].includes(roleTypeCode) ? 'HQ' : null;
  switch (roleTypeCode) {
    case 'BM':
    case 'BA':
      return 'HQ';
    case 'FM':
    case 'FA':
      return roleTypeCode;
    default:
      return null;
  }
}

/**
 * 볼 수 있는가. 본사는 세 역할 모두 — 일부 점포 담당이어도 점포로 좁히지 않는다(CONFIG-1). 가맹 쪽은 본인과,
 * 매핑 점포가 하나라도 겹치는 가맹 관리자만(2026-09-29 · 본인은 2026-10-23). 연결 가맹 마스터는 자기 가맹 관리자를
 * 점포와 관계없이 본다 — 점포 축소 연쇄로 0곳이 된 가맹 관리자를 고칠 사람은 그뿐이다(PR #160 리뷰).
 */
export function canSee(caller: BpAdminCaller, target: BpAdminTarget): boolean {
  if (caller.side === 'HQ') return true;
  if (target.adminAccountId === caller.adminAccountId) return true;
  if (
    caller.side === 'FM' &&
    target.roleTypeCode === 'FA' &&
    target.franchiseMasterId === caller.adminAccountId
  )
    return true;
  return (
    target.roleTypeCode === 'FA' &&
    target.storeIds.some((id) => caller.storeIds.includes(id))
  );
}

/** 등록할 수 있는 역할 — 본사는 BP 관리자 · 가맹 마스터, 가맹 마스터는 가맹 관리자만. */
export function creatableRoles(caller: BpAdminCaller): BpAdminRole[] {
  if (caller.side === 'HQ') return ['BA', 'FM'];
  if (caller.side === 'FM') return ['FA'];
  return [];
}

/**
 * 상세의 버튼 판정. 메뉴 권한(수정)은 가드와 화면이 따로 본다 — 여기는 역할 규칙만이다.
 * - BP 관리자 · 가맹 마스터 계정은 본사가, 가맹 관리자 계정은 연결 가맹 마스터만 고친다(CONFIG-2).
 * - 본인 계정은 기본정보만 고치고 초기화하지 않는다. 가맹 관리자는 본인 계정도 조회만 한다.
 * - 범위(전체 · 일부)는 BP 관리자 계정에만 있고, 전체 점포를 맡은 사람만 바꾼다.
 * - 가맹 마스터의 권한 그룹은 고정(FM000001)이다.
 */
export function actionsOf(
  caller: BpAdminCaller,
  target: BpAdminTarget,
): BpAdminActions {
  const isSelf = target.adminAccountId === caller.adminAccountId;
  if (isSelf)
    return {
      isSelf,
      canUpdate: caller.side !== 'FA',
      canResetPassword: false,
      canChangeScope: false,
      canChangeRoleGroup: false,
    };
  const canUpdate =
    target.roleTypeCode === 'FA'
      ? caller.side === 'FM' &&
        target.franchiseMasterId === caller.adminAccountId
      : caller.side === 'HQ';
  return {
    isSelf,
    canUpdate,
    canResetPassword: canUpdate,
    canChangeScope:
      canUpdate && target.roleTypeCode === 'BA' && caller.isAllStores,
    canChangeRoleGroup: canUpdate && target.roleTypeCode !== 'FM',
  };
}

/** 본인 계정은 기본정보만 고친다 — 권한 그룹 · 상태 · 점포는 다른 사람이 바꾼다. */
export function assertSelfEdit(
  isSelf: boolean,
  change: {
    roleGroupChanged: boolean;
    statusChanged: boolean;
    storesChanged: boolean;
  },
): void {
  if (
    isSelf &&
    (change.roleGroupChanged || change.statusChanged || change.storesChanged)
  )
    throw new ForbiddenException(
      '본인 계정은 이름 · 휴대전화 · 이메일만 고칠 수 있습니다',
    );
}

/**
 * 저장할 점포 범위. 전체 점포는 BP 관리자에게만, 전체 점포를 맡은 사람만 준다. 일부 점포면:
 * - 고른 점포는 `allowed`(호출자의 관리 점포 — 가맹 관리자는 연결 가맹 마스터만 고치므로 곧 그 마스터의 점포) 안이어야 한다.
 * - `allowed` 밖에 이미 매핑된 점포는 요청에 없어도 남긴다(범위 밖 매핑, 2026-09-29).
 * - 새로 붙이는 점포는 폐점이 아니어야 한다. 이미 붙은 폐점 점포는 요청에 다시 넣으면 남는다 — 빼면 지워진다
 *   (2026-10-23). 점포 선택지에는 폐점이 없으므로 화면은 상세의 매핑 점포에서 다시 보낸다.
 * - 남는 점포가 한 곳 이상이어야 한다.
 * 일부 점포 담당이 전체 점포 계정을 고치면 전체 점포가 그대로 남고, 일부로 내리려 하면 403 이다.
 */
export function planStores(input: {
  caller: BpAdminCaller;
  role: BpAdminRole;
  requested: { isAllStores: boolean; storeIds: number[] };
  current?: { isAllStores: boolean; storeIds: number[] };
  allowed: Set<number>;
  closed: Set<number>;
}): { isAllStores: boolean; storeIds: number[] } {
  const { caller, role, requested, current, allowed, closed } = input;
  if (requested.isAllStores) {
    if (role !== 'BA')
      throw new BadRequestException(
        '전체 점포는 BP 관리자에게만 줄 수 있습니다',
      );
    if (!current?.isAllStores && !caller.isAllStores)
      throw new ForbiddenException(
        '전체 점포는 전체 점포를 맡은 사람만 줄 수 있습니다',
      );
    return { isAllStores: true, storeIds: [] };
  }
  if (current?.isAllStores && !caller.isAllStores)
    throw new ForbiddenException(
      '전체 점포 계정의 범위는 전체 점포를 맡은 사람만 바꿀 수 있습니다',
    );
  if (requested.storeIds.some((id) => !allowed.has(id)))
    throw new BadRequestException(OUT_OF_SCOPE);
  const before = current?.isAllStores ? [] : (current?.storeIds ?? []);
  if (requested.storeIds.some((id) => closed.has(id) && !before.includes(id)))
    throw new BadRequestException('폐점한 점포는 새로 맡길 수 없습니다');
  const kept = before.filter((id) => !allowed.has(id));
  const storeIds = [...new Set([...kept, ...requested.storeIds])].sort(
    (a, b) => a - b,
  );
  if (!storeIds.length)
    throw new BadRequestException('관리 점포를 한 곳 이상 골라 주세요');
  return { isAllStores: false, storeIds };
}

/**
 * 가맹 마스터에서 뺀 점포를 연결 가맹 관리자에게서도 뺀다(2026-10-23). 영향받는 계정만 전후 목록과 함께 돌려준다.
 * 0곳이 되어도 그대로다 — 계정 상태는 바꾸지 않고, 점포 필수 검사는 그 계정을 다음에 고칠 때 걸린다.
 */
export function shrinkCascade(
  removedStoreIds: number[],
  franchiseAdmins: { adminAccountId: number; storeIds: number[] }[],
): { adminAccountId: number; before: number[]; after: number[] }[] {
  const removed = new Set(removedStoreIds);
  return franchiseAdmins
    .filter((a) => a.storeIds.some((id) => removed.has(id)))
    .map((a) => ({
      adminAccountId: a.adminAccountId,
      before: a.storeIds,
      after: a.storeIds.filter((id) => !removed.has(id)),
    }));
}
