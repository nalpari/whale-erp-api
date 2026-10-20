import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  NOT_FOUND,
  PLATFORM_ROLE_GROUP_TYPES,
  PLATFORM_ROLE_MENU,
} from './platform-role-group-format';
import { type CellFlags, NO_FLAGS } from './role-menu-rules';

export type Tx = Prisma.TransactionClient;
export type Db = Tx | PrismaService;

/** 이 화면이 다루는 권한 그룹 — 플랫폼 BP 의 지우지 않은 PM · PA · BM · FM. BA · FA 는 BP 가 만든다. */
export function platformRoleGroupWhere(
  roleGroupId?: number,
): Prisma.RoleGroupWhereInput {
  return {
    ...(roleGroupId !== undefined && { roleGroupId }),
    isDeleted: false,
    roleTypeCode: { in: [...PLATFORM_ROLE_GROUP_TYPES] },
    bpCode: { isPlatform: true },
  };
}

const TARGET_SELECT = {
  roleGroupId: true,
  roleCode: true,
  roleTypeCode: true,
  name: true,
  description: true,
  isMaster: true,
  updatedAt: true,
} as const;

/** 대상 권한 그룹. 없거나 지웠거나 이 화면이 다루지 않는 그룹이면 404. */
export async function findPlatformRoleGroup(db: Db, roleGroupId: number) {
  const group = await db.roleGroup.findFirst({
    where: platformRoleGroupWhere(roleGroupId),
    select: TARGET_SELECT,
  });
  if (!group) throw new NotFoundException(NOT_FOUND);
  return group;
}

const FLAG_SELECT = {
  isReadable: true,
  isCreatable: true,
  isUpdatable: true,
  isDeletable: true,
} as const;

export function flagsOf(row: {
  isReadable: boolean;
  isCreatable: boolean;
  isUpdatable: boolean;
  isDeletable: boolean;
}): CellFlags {
  return {
    read: row.isReadable,
    create: row.isCreatable,
    update: row.isUpdatable,
    delete: row.isDeletable,
  };
}

export function columnsOf(flags: CellFlags) {
  return {
    isReadable: flags.read,
    isCreatable: flags.create,
    isUpdatable: flags.update,
    isDeletable: flags.delete,
  };
}

/** 그룹의 메뉴별 권한(지우지 않은 행). 행이 없는 메뉴는 Map 에 없다 — 모두 꺼진 것이다. */
export async function grantsOf(
  db: Db,
  roleGroupId: number,
): Promise<Map<number, CellFlags>> {
  const rows = await db.roleGroupMenu.findMany({
    where: { roleGroupId, isDeleted: false },
    select: { menuId: true, ...FLAG_SELECT },
  });
  return new Map(rows.map((r) => [r.menuId, flagsOf(r)]));
}

/**
 * 호출자 권한 그룹의 권한 관리 메뉴(MN000214) 칸. 컨트롤러의 가드가 이미 동작 하나를 봤고, 여기서는 화면에
 * 수정 · 삭제를 열지 가르는 데 쓴다. 행이 없으면 모두 꺼진 것이다.
 */
export async function callerRoleMenuRights(
  db: Db,
  roleGroupId: number,
): Promise<CellFlags> {
  const row = await db.roleGroupMenu.findFirst({
    where: {
      roleGroupId,
      isDeleted: false,
      menu: { menuCode: PLATFORM_ROLE_MENU, isDeleted: false },
    },
    select: FLAG_SELECT,
  });
  return row ? flagsOf(row) : { ...NO_FLAGS };
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
