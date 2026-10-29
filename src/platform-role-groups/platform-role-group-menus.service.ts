import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { CodesService, PLATFORM_BP_CODE } from '../codes/codes.service';
import { sameMillisecond } from '../common/updated-at';
import {
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  RoleGroupMenuCellResponseDto,
  RoleGroupMenuNodeResponseDto,
  RoleGroupMenuRevocationPreviewResponseDto,
  RoleGroupMenuTreeResponseDto,
  SaveRoleGroupMenusResponseDto,
} from './dto/platform-role-group.response.dto';
import type {
  PreviewRoleGroupMenusDto,
  RoleGroupMenuCellsDto,
  SaveRoleGroupMenusDto,
} from './dto/save-platform-role-group.dto';
import {
  columnsOf,
  type Db,
  findPlatformRoleGroup,
  flagsOf,
  grantsOf,
  type Tx,
} from './platform-role-group-access';
import {
  CASCADE_CHILD_TYPE,
  CHANGED_MEANWHILE,
  PLATFORM_ROLE_MENU_URL,
  SELF_LINKED,
} from './platform-role-group-format';
import {
  type BpMasterType,
  cascadeFlags,
  type CellBlockReason,
  type CellChange,
  type CellFlags,
  cellBlock,
  changedCells,
  groupMenuIds,
  hasWriteWithoutRead,
  isBpMaster,
  MENU_OPS,
  type MenuNode,
  type MenuOp,
  NO_FLAGS,
  normalizeGroups,
  PLATFORM_SERVICE,
  visibleMenus,
} from './role-menu-rules';

const ALL_FLAGS: CellFlags = {
  read: true,
  create: true,
  update: true,
  delete: true,
};
const GROUP_FLAGS: CellFlags = { ...NO_FLAGS, read: true };

/** 메뉴 카탈로그 — 한 요청 안에서 트리 · 저장 · 미리보기가 같은 「보이는 메뉴」를 쓴다. */
export interface Catalog {
  services: { value: string; label: string }[];
  /** 지우지 않은 메뉴 전부(숨긴 것 포함) */
  byId: Map<number, MenuNode>;
  visible: MenuNode[];
  groups: Set<number>;
}

type Target = Awaited<ReturnType<typeof findPlatformRoleGroup>>;
type CascadeHit = {
  roleGroupId: number;
  menuId: number;
  from: CellFlags;
  to: CellFlags;
};

/**
 * 플랫폼 권한 관리의 메뉴 등록 팝업(S-EFQREM) — 메뉴 트리, 메뉴별 CRUD 저장, 고정 권한 회수 미리보기.
 *
 * 규칙은 role-menu-rules 가 판정한다. 여기서 지키는 것:
 * - 숨긴 메뉴(사용중지 메뉴 · 사용중지 상위 아래 · 사용중지 서비스 · 지운 메뉴)는 트리에 없고 보내면 400, 기존 행은 보존.
 * - 묶음 메뉴는 하위에서 다시 정한다(조회만). 등록 · 수정 · 삭제가 켜진 줄은 조회도 켜져야 한다.
 * - PA 호출자가 PA 쪽 권한을 바꿀 때 바뀐 칸은 호출자 본인 권한 안이어야 한다(켜기 · 끄기 모두).
 * - BP · 가맹 마스터에서 끈 칸은 같은 트랜잭션에서 모든 BP 의 BA · FA 그룹에서도 끈다.
 */
@Injectable()
export class PlatformRoleGroupMenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodesService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  /** 서비스별 메뉴 트리와 칸마다 바꿀 수 있는지 · 막힌 이유. */
  async tree(
    callerId: number,
    roleGroupId: number,
  ): Promise<RoleGroupMenuTreeResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const target = await findPlatformRoleGroup(this.prisma, roleGroupId);
    const catalog = await loadCatalog(this.prisma, this.codes);
    const [targetGrants, callerGrants] = await Promise.all([
      grantsOf(this.prisma, roleGroupId),
      grantsOf(this.prisma, caller.roleGroupId),
    ]);
    const roleMenu = [...catalog.byId.values()].find(
      // 가드처럼 사용 중 메뉴로 — 사용중지 메뉴가 같은 주소를 가질 수 있다.
      (m) => m.url === PLATFORM_ROLE_MENU_URL && m.status === 'ACTIVE',
    );
    const canUpdate =
      (roleMenu && callerGrants.get(roleMenu.menuId)?.update) ?? false;
    const isSelfLinked = caller.roleGroupId === roleGroupId;
    const isPm = target.roleTypeCode === 'PM';

    const ownBlock = (menu: MenuNode, op: MenuOp) =>
      cellBlock(
        {
          targetRoleType: target.roleTypeCode,
          isSelfLinked,
          canUpdate,
          callerRoleType: caller.roleTypeCode,
          callerGrant: callerGrants.get(menu.menuId),
          serviceCode: menu.serviceCode,
          current: valueOf(menu.menuId),
        },
        op,
      );
    // 플랫폼 마스터는 전체 허용 고정으로 보인다 — 저장된 행이 아니라 고정 규칙을 보인다.
    const valueOf = (menuId: number): CellFlags =>
      isPm
        ? catalog.groups.has(menuId)
          ? GROUP_FLAGS
          : ALL_FLAGS
        : (targetGrants.get(menuId) ?? NO_FLAGS);

    return {
      roleGroupId: target.roleGroupId,
      roleCode: target.roleCode,
      roleTypeCode: target.roleTypeCode,
      name: target.name,
      updatedAt: target.updatedAt,
      isSavable: !isPm && canUpdate && !isSelfLinked,
      services: menuTreeServices(catalog, valueOf, ownBlock),
    };
  }

  /**
   * 메뉴 권한 저장. 그룹 행의 updatedAt 을 먼저 올려(같은 ms 일 때만) 동시 저장을 줄 세운 뒤, 그 안에서 현재 값을
   * 읽어 바뀐 칸을 구한다. 행이 없으면 만들고 있으면 고친다 — 모두 꺼도 행은 지우지 않고 네 칸을 false 로 둔다.
   */
  async save(
    callerId: number,
    roleGroupId: number,
    dto: SaveRoleGroupMenusDto,
  ): Promise<SaveRoleGroupMenusResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const target = await findPlatformRoleGroup(this.prisma, roleGroupId);
    assertMenusSavable(target);
    if (caller.roleGroupId === roleGroupId)
      throw new ForbiddenException(SELF_LINKED);
    const catalog = await loadCatalog(this.prisma, this.codes);
    const submitted = submittedCells(dto.menus, catalog);
    const ceiling = await this.ceilingOf(caller, target);
    const by = caller.adminAccountId;

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.roleGroup.updateMany({
        where: {
          roleGroupId,
          isDeleted: false,
          updatedAt: sameMillisecond(dto.updatedAt),
        },
        data: { updatedBy: by },
      });
      if (count === 0) {
        // 그 사이 지워졌으면 404 — 다시 불러와도 없으니 409 로 안내하지 않는다.
        await findPlatformRoleGroup(tx, roleGroupId);
        throw new ConflictException(CHANGED_MEANWHILE);
      }

      const before = await grantsOf(tx, roleGroupId);
      const after = planAfter(before, submitted, catalog.visible);
      const changes = changedCells(before, after, idsOf(catalog.visible));
      assertAllowed(target, changes, catalog, ceiling);

      const changedIds = [...new Set(changes.map((c) => c.menuId))];
      for (const menuId of changedIds) {
        const flags = columnsOf(after.get(menuId) ?? NO_FLAGS);
        await tx.roleGroupMenu.upsert({
          where: { roleGroupId_menuId: { roleGroupId, menuId } },
          create: {
            roleGroupId,
            menuId,
            ...flags,
            createdBy: by,
            updatedBy: by,
          },
          update: { ...flags, isDeleted: false, updatedBy: by },
        });
      }

      if (isBpMaster(target.roleTypeCode)) {
        const hits = await cascadeHits(
          tx,
          target.roleTypeCode,
          changes,
          catalog,
        );
        await applyCascade(tx, hits, by);
      }

      const { updatedAt } = await tx.roleGroup.findUniqueOrThrow({
        where: { roleGroupId },
        select: { updatedAt: true },
      });
      return { updatedAt };
    });
  }

  /**
   * 회수 미리보기 — 저장과 같은 계산 · 같은 검사를 하되 쓰지 않고 센다. 조회 권한이면 된다. 저장이 막힐
   * 변경(플랫폼 마스터 409, BP 쪽 플랫폼 메뉴 켜기 · 본인 범위 밖 칸 400)은 여기서도 같은 응답이라, 화면이 저장
   * 전에 알 수 있다.
   */
  async preview(
    callerId: number,
    roleGroupId: number,
    dto: PreviewRoleGroupMenusDto,
  ): Promise<RoleGroupMenuRevocationPreviewResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const target = await findPlatformRoleGroup(this.prisma, roleGroupId);
    assertMenusSavable(target);
    const catalog = await loadCatalog(this.prisma, this.codes);
    const submitted = submittedCells(dto.menus, catalog);
    const before = await grantsOf(this.prisma, roleGroupId);
    const after = planAfter(before, submitted, catalog.visible);
    const changes = changedCells(before, after, idsOf(catalog.visible));
    assertAllowed(
      target,
      changes,
      catalog,
      await this.ceilingOf(caller, target),
    );
    const revokedCells = changes.filter((c) => c.from && !c.to).length;
    // 회수가 없으면 아무도 영향받지 않는다 — 고정 권한 자신의 관리자도 세지 않는다.
    if (!isBpMaster(target.roleTypeCode) || revokedCells === 0)
      return { revokedCells, affectedRoleGroupCount: 0, affectedAdminCount: 0 };

    const hits = await cascadeHits(
      this.prisma,
      target.roleTypeCode,
      changes,
      catalog,
    );
    const groupIds = [...new Set(hits.map((h) => h.roleGroupId))];
    const affectedAdminCount = await this.prisma.adminAccount.count({
      where: {
        isDeleted: false,
        roleGroupId: { in: [...groupIds, roleGroupId] },
      },
    });
    return {
      revokedCells,
      affectedRoleGroupCount: groupIds.length,
      affectedAdminCount,
    };
  }

  /** 본인 범위 상한은 PA 쪽 권한을 PA 호출자가 바꿀 때만(SYSTEM-6). PM 은 전체, BP · 가맹 마스터에는 걸지 않는다. */
  private async ceilingOf(
    caller: MenuCaller,
    target: Target,
  ): Promise<Map<number, CellFlags> | null> {
    return target.roleTypeCode === 'PA' && caller.roleTypeCode === 'PA'
      ? grantsOf(this.prisma, caller.roleGroupId)
      : null;
  }
}

/**
 * 메뉴 카탈로그를 읽는다. only 를 주면 그 서비스만 남긴다 — BP 권한 그룹은 WHALE_ERP 만 본다.
 */
export async function loadCatalog(
  db: Db,
  codes: CodesService,
  only?: readonly string[],
): Promise<Catalog> {
  const all = (await codes.forBp(PLATFORM_BP_CODE)).SERVICE ?? [];
  const services = only ? all.filter((s) => only.includes(s.value)) : all;
  // 플랫폼고정 공통코드라 비어 있으면(only 로 거른 서비스가 사용 중이 아니어도) 데이터 오류다. 빈 트리로 답하면 저장마다
  // 엉뚱한 400 이 난다.
  if (services.length === 0)
    throw new InternalServerErrorException(
      '공통코드 SERVICE 가 없거나 사용 중인 서비스(또는 이 화면의 서비스)가 없습니다 — 플랫폼 공통코드를 확인해 주세요.',
    );
  const menus = await db.menu.findMany({
    where: { isDeleted: false },
    select: {
      menuId: true,
      parentMenuId: true,
      menuCode: true,
      serviceCode: true,
      name: true,
      depth: true,
      sortOrder: true,
      status: true,
      url: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { menuId: 'asc' }],
  });
  const visible = visibleMenus(menus, new Set(services.map((s) => s.value)));
  return {
    services,
    byId: new Map(menus.map((m) => [m.menuId, m])),
    visible,
    groups: groupMenuIds(visible),
  };
}

/**
 * 서비스별 메뉴 트리. ownBlock 은 칸 하나의 판정이고, 묶음 칸은 하위에서 정한다 — 본인 상한은 열린 하위가 하나라도
 * 있으면 연다(목업과 같다).
 */
export function menuTreeServices(
  catalog: Catalog,
  valueOf: (menuId: number) => CellFlags,
  ownBlock: (menu: MenuNode, op: MenuOp) => CellBlockReason | null,
): RoleGroupMenuTreeResponseDto['services'] {
  const childrenOf = new Map<number | null, MenuNode[]>();
  for (const m of [...catalog.visible].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.menuId - b.menuId,
  ))
    childrenOf.set(m.parentMenuId, [
      ...(childrenOf.get(m.parentMenuId) ?? []),
      m,
    ]);
  const leavesOf = (menu: MenuNode): MenuNode[] =>
    (childrenOf.get(menu.menuId) ?? []).flatMap((c) =>
      catalog.groups.has(c.menuId) ? leavesOf(c) : [c],
    );
  const blockOf = (menu: MenuNode, op: MenuOp): CellBlockReason | null => {
    const own = ownBlock(menu, op);
    if (!catalog.groups.has(menu.menuId)) return own;
    if (own !== null && own !== 'OUT_OF_SCOPE') return own;
    return leavesOf(menu).some((leaf) => ownBlock(leaf, op) === null)
      ? null
      : 'OUT_OF_SCOPE';
  };
  const cell = (
    menu: MenuNode,
    op: MenuOp,
    value: boolean,
  ): RoleGroupMenuCellResponseDto => {
    const blockedReason = blockOf(menu, op);
    return { value, editable: blockedReason === null, blockedReason };
  };
  const build = (parentId: number | null, service: string) =>
    (childrenOf.get(parentId) ?? [])
      .filter((m) => m.serviceCode === service)
      .map((menu): RoleGroupMenuNodeResponseDto => {
        const value = valueOf(menu.menuId);
        return {
          menuId: menu.menuId,
          menuCode: menu.menuCode,
          name: menu.name,
          depth: menu.depth,
          isGroup: catalog.groups.has(menu.menuId),
          read: cell(menu, 'read', value.read),
          create: cell(menu, 'create', value.create),
          update: cell(menu, 'update', value.update),
          delete: cell(menu, 'delete', value.delete),
          children: build(menu.menuId, service),
        };
      });
  return catalog.services.map((s) => ({
    serviceCode: s.value,
    name: s.label,
    menus: build(null, s.value),
  }));
}

/** 보낸 줄을 확인해 일반 메뉴의 칸만 남긴다 — 묶음 메뉴 줄은 하위에서 다시 정하므로 버린다. */
export function submittedCells(
  menus: RoleGroupMenuCellsDto[],
  catalog: Catalog,
): Map<number, CellFlags> {
  const visibleIds = new Set(idsOf(catalog.visible));
  const out = new Map<number, CellFlags>();
  const seen = new Set<number>();
  for (const row of menus) {
    if (seen.has(row.menuId))
      throw new BadRequestException(
        `같은 메뉴가 두 번 있습니다(menuId ${row.menuId}).`,
      );
    seen.add(row.menuId);
    if (!visibleIds.has(row.menuId))
      throw new BadRequestException(
        `메뉴 트리에 없는 메뉴입니다(menuId ${row.menuId}) — 사용중지 · 삭제된 메뉴는 권한을 줄 수 없습니다.`,
      );
    if (catalog.groups.has(row.menuId)) continue;
    const flags: CellFlags = {
      read: row.read,
      create: row.create,
      update: row.update,
      delete: row.delete,
    };
    if (hasWriteWithoutRead(flags))
      throw new BadRequestException(
        '등록 · 수정 · 삭제를 켜려면 조회도 켜야 합니다.',
      );
    out.set(row.menuId, flags);
  }
  return out;
}

/** 현재 값 위에 보낸 칸을 얹고 묶음 메뉴를 다시 정한다. 보내지 않은 메뉴 · 숨긴 메뉴는 그대로다. */
export function planAfter(
  before: Map<number, CellFlags>,
  submitted: Map<number, CellFlags>,
  visible: MenuNode[],
): Map<number, CellFlags> {
  const after = new Map(before);
  for (const [menuId, flags] of submitted) after.set(menuId, flags);
  return normalizeGroups(visible, after);
}

export function assertAllowed(
  target: { roleTypeCode: string },
  changes: CellChange[],
  catalog: Catalog,
  ceiling: Map<number, CellFlags> | null,
): void {
  for (const c of changes) {
    const menu = catalog.byId.get(c.menuId)!;
    if (
      isBpMaster(target.roleTypeCode) &&
      menu.serviceCode === PLATFORM_SERVICE &&
      c.to
    )
      throw new BadRequestException(
        'BP 마스터·가맹 마스터 권한에는 플랫폼 관리 메뉴를 줄 수 없습니다.',
      );
    // 묶음 칸은 하위에서 따라 바뀌므로 하위 칸이 상한을 대신 받는다.
    if (
      ceiling &&
      !catalog.groups.has(c.menuId) &&
      !ceiling.get(c.menuId)?.[c.op]
    )
      throw new BadRequestException('본인 권한 범위 밖 칸은 바꿀 수 없습니다.');
  }
}

/** 플랫폼 마스터 권한은 전체 허용 고정이라 메뉴를 저장하지 않는다 — 저장과 미리보기가 같은 409 를 준다. */
function assertMenusSavable(target: Target): void {
  if (target.roleTypeCode === 'PM')
    throw new ConflictException(
      '플랫폼 마스터 권한은 전체 메뉴 허용으로 고정되어 바꿀 수 없습니다.',
    );
}

/**
 * 고정 권한에서 끈 칸이 켜져 있는 BA · FA 그룹의 행과 끈 뒤 값. 바뀌지 않는 행은 뺀다. 그 결과 그룹 안에서 하위
 * 조회가 모두 꺼지는 묶음 메뉴도 끈다 — 고정 권한 쪽은 다른 하위가 남아 묶음이 켜져 있어도, 그 그룹에는 빈 묶음이
 * 남지 않게. 묶음을 켜는 쪽으로는 고치지 않는다(연쇄는 회수만 한다).
 */
async function cascadeHits(
  db: Db,
  masterType: BpMasterType,
  changes: CellChange[],
  catalog: Catalog,
): Promise<CascadeHit[]> {
  const revoked = new Map<number, Set<MenuOp>>();
  for (const c of changes)
    if (c.from && !c.to)
      revoked.set(c.menuId, (revoked.get(c.menuId) ?? new Set()).add(c.op));
  if (revoked.size === 0) return [];
  const rows = await db.roleGroupMenu.findMany({
    where: {
      menuId: { in: [...revoked.keys()] },
      isDeleted: false,
      roleGroup: {
        isDeleted: false,
        roleTypeCode: CASCADE_CHILD_TYPE[masterType],
      },
    },
    select: {
      roleGroupId: true,
      menuId: true,
      isReadable: true,
      isCreatable: true,
      isUpdatable: true,
      isDeletable: true,
    },
    orderBy: [{ roleGroupId: 'asc' }, { menuId: 'asc' }],
  });
  const hits = rows.flatMap((row) => {
    const from = flagsOf(row);
    const to = cascadeFlags(from, revoked.get(row.menuId)!);
    return MENU_OPS.some((op) => from[op] !== to[op])
      ? [{ roleGroupId: row.roleGroupId, menuId: row.menuId, from, to }]
      : [];
  });

  const groupHits: CascadeHit[] = [];
  for (const roleGroupId of new Set(hits.map((h) => h.roleGroupId))) {
    const before = await grantsOf(db, roleGroupId);
    const after = new Map(before);
    for (const h of hits)
      if (h.roleGroupId === roleGroupId) after.set(h.menuId, h.to);
    const normalized = normalizeGroups(catalog.visible, after);
    for (const menuId of catalog.groups) {
      const from = before.get(menuId);
      if (from?.read && !normalized.get(menuId)?.read)
        groupHits.push({ roleGroupId, menuId, from, to: { ...NO_FLAGS } });
    }
  }
  return [...hits, ...groupHits];
}

/** 회수 연쇄를 쓴다 — 행마다 고치고, 바뀐 그룹의 최종수정을 올린다. */
async function applyCascade(
  tx: Tx,
  hits: CascadeHit[],
  by: number,
): Promise<void> {
  if (hits.length === 0) return;
  for (const hit of hits)
    await tx.roleGroupMenu.update({
      where: {
        roleGroupId_menuId: {
          roleGroupId: hit.roleGroupId,
          menuId: hit.menuId,
        },
      },
      data: { ...columnsOf(hit.to), updatedBy: by },
    });
  await tx.roleGroup.updateMany({
    where: {
      roleGroupId: { in: [...new Set(hits.map((h) => h.roleGroupId))] },
    },
    data: { updatedBy: by },
  });
}

export function idsOf(menus: MenuNode[]): number[] {
  return menus.map((m) => m.menuId);
}
