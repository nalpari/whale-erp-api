import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import {
  OTHER_BP_MESSAGE,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import type { Db } from '../platform-role-groups/platform-role-group-access';
import { NOT_FOUND } from '../platform-role-groups/platform-role-group-format';
import {
  type CellBlockReason,
  type CellFlags,
  MENU_OPS,
  type MenuOp,
} from '../platform-role-groups/role-menu-rules';

/** 메뉴 「BP 권한 그룹 관리」(/bp-role-groups) */
export const BP_ROLE_MENU = 'MN000013';

/** 이 화면이 다루는 권한 유형 — BP 관리자 · 가맹 관리자. 응답 DTO 의 enum 도 이 목록을 쓴다. */
export const BP_ROLE_GROUP_TYPES = ['BA', 'FA'] as const;
export type BpRoleType = (typeof BP_ROLE_GROUP_TYPES)[number];
/** 메뉴 트리 응답의 유형 — 가맹마스터 보기가 FM000001 을 돌려준다. */
export const BP_ROLE_TREE_TYPES = ['BA', 'FA', 'FM'] as const;

/** BP 권한 그룹의 메뉴 트리 서비스. BP 별 허용 서비스 데이터가 없어 WHALE_ERP 로 고정한다(요청서 열린 질문 1). */
export const BP_ROLE_SERVICES = ['WHALE_ERP'] as const;

/** 기준 고정 권한 — BA 는 BM000001, FA 는 FM000001 을 넘지 못한다. */
export const BASE_ROLE_CODE = { BA: 'BM000001', FA: 'FM000001' } as const;

/** 호출자가 이 화면에서 볼 수 있고 쓸 수 있는 범위. */
export interface BpScope {
  caller: MenuCaller;
  bpCodeId: number;
  /** FA 그룹을 이 관리계정의 것으로 좁힌다 — FM 은 본인, FA 는 연결 가맹 마스터. null 이면 BP 의 BA + FA 전체. */
  managerId: number | null;
  /** 등록 · 수정 · 삭제 · 메뉴 저장할 수 있는 유형 — BM 은 BA, FM 은 FA, 나머지는 null(조회만). */
  writableType: BpRoleType | null;
}

/**
 * 호출자의 범위. 대상 BP 는 가드가 정했다(`@TargetBp()` — BP 사용자는 소속 BP, 플랫폼 사용자는 헤더의 고객 BP).
 * 플랫폼 사용자(PM · PA)는 조회만 하고, 헤더 없이 부르면 대상이 플랫폼 BP 라 400 이다. 연결 가맹 마스터가 없는
 * 가맹 관리자는 볼 그룹이 없어 403.
 */
export async function resolveScope(
  db: Db,
  caller: MenuCaller,
  bp: TargetBpContext,
): Promise<BpScope> {
  const account = await db.adminAccount.findFirst({
    where: { adminAccountId: caller.adminAccountId },
    select: {
      bpCodeId: true,
      bpCode: { select: { isPlatform: true } },
      roleGroup: { select: { managerAdminAccountId: true } },
    },
  });
  if (!account) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
  // 가드와 같은 판정(isPlatformRole). 플랫폼 BP 에 붙은 BP 쪽 유형은 403, 고객 BP 에 붙은 PM · PA 는 아래 default 403.
  const isPlatformType = isPlatformRole(
    caller.roleTypeCode,
    account.bpCode.isPlatform,
  );
  if (account.bpCode.isPlatform !== isPlatformType)
    throw new ForbiddenException(ACCESS_DENIED_MESSAGE);

  if (isPlatformType) {
    if (bp.bpCodeId === account.bpCodeId)
      throw new BadRequestException('권한 그룹을 볼 BP 를 골라 주세요.');
    return {
      caller,
      bpCodeId: bp.bpCodeId,
      managerId: null,
      writableType: null,
    };
  }

  // 가드가 이미 막지만, 가드와 이 조회 사이에 소속이 바뀌었으면 다른 BP 를 쓰지 않는다.
  if (bp.bpCodeId !== account.bpCodeId)
    throw new ForbiddenException(OTHER_BP_MESSAGE);
  const base = { caller, bpCodeId: account.bpCodeId };
  switch (caller.roleTypeCode) {
    case 'BM':
      return { ...base, managerId: null, writableType: 'BA' };
    case 'BA':
      return { ...base, managerId: null, writableType: null };
    case 'FM':
      return { ...base, managerId: caller.adminAccountId, writableType: 'FA' };
    case 'FA': {
      const managerId = account.roleGroup.managerAdminAccountId;
      if (managerId === null)
        throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
      return { ...base, managerId, writableType: null };
    }
    default:
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
  }
}

/** 범위 안의 그룹 — 그 BP 의 지우지 않은 비고정 BA · FA. 관리계정이 정해지면 그 관리계정의 FA 만. */
export function visibleWhere(
  scope: BpScope,
  roleGroupId?: number,
): Prisma.RoleGroupWhereInput {
  return {
    ...(roleGroupId !== undefined && { roleGroupId }),
    bpCodeId: scope.bpCodeId,
    isDeleted: false,
    isMaster: false,
    ...(scope.managerId === null
      ? { roleTypeCode: { in: [...BP_ROLE_GROUP_TYPES] } }
      : { roleTypeCode: 'FA', managerAdminAccountId: scope.managerId }),
  };
}

const TARGET_SELECT = {
  roleGroupId: true,
  roleCode: true,
  roleTypeCode: true,
  name: true,
  managerAdminAccountId: true,
  updatedAt: true,
} as const;

/** 범위 안의 대상 그룹. 없거나 범위 밖이면 404 — 있는지도 알리지 않는다. */
export async function findBpRoleGroup(
  db: Db,
  scope: BpScope,
  roleGroupId: number,
) {
  const group = await db.roleGroup.findFirst({
    where: visibleWhere(scope, roleGroupId),
    select: TARGET_SELECT,
  });
  if (!group) throw new NotFoundException(NOT_FOUND);
  return group;
}

/** 역할로 이 그룹을 고칠 수 있는가. FM 의 범위는 이미 본인 FA 로 좁혀져 있어 유형만 보면 된다. */
export function canWrite(
  scope: BpScope,
  group: { roleTypeCode: string },
): boolean {
  return scope.writableType === group.roleTypeCode;
}

/** 두 그룹 모두 켠 칸 — 기준 고정 권한과 호출자 본인 권한의 교집합이 메뉴 칸의 상한이다. */
export function intersectGrants(
  a: Map<number, CellFlags>,
  b: Map<number, CellFlags>,
): Map<number, CellFlags> {
  const out = new Map<number, CellFlags>();
  for (const [menuId, x] of a) {
    const y = b.get(menuId);
    if (!y) continue;
    out.set(menuId, {
      read: x.read && y.read,
      create: x.create && y.create,
      update: x.update && y.update,
      delete: x.delete && y.delete,
    });
  }
  return out;
}

export interface BpCellContext {
  canWrite: boolean;
  isSelfLinked: boolean;
  /** 상한의 같은 메뉴 칸. 행이 없으면 undefined. */
  ceiling: CellFlags | undefined;
  current: CellFlags;
}

/**
 * BP 권한 그룹의 칸 하나를 바꿀 수 없는 이유 — 조회만, 본인 연결, 상한 밖 순서. 켜진 조회 칸은 끄면 나머지도
 * 꺼지므로, 그중 켜진 칸이 상한 밖이면 조회 칸도 막는다(저장이 400). 플랫폼의 PA 상한 판정과 같다.
 */
export function bpCellBlock(
  ctx: BpCellContext,
  op: MenuOp,
): CellBlockReason | null {
  if (!ctx.canWrite) return 'READ_ONLY';
  if (ctx.isSelfLinked) return 'SELF_LINKED';
  const allowed = (o: MenuOp) => ctx.ceiling?.[o] ?? false;
  if (!allowed(op)) return 'OUT_OF_SCOPE';
  if (
    op === 'read' &&
    ctx.current.read &&
    MENU_OPS.some((o) => ctx.current[o] && !allowed(o))
  )
    return 'OUT_OF_SCOPE';
  return null;
}
