/**
 * 권한 그룹의 메뉴별 CRUD 를 다루는 순수 규칙. 플랫폼 권한 관리(MN000214)의 메뉴 트리 · 저장 · 회수 미리보기가
 * 같은 판정을 쓰도록 DB 를 모르는 함수로 둔다. 목업 docs/mockup/system/roles.html 의 blockOf · revoked 와 같다.
 */

/** 메뉴별 권한의 네 동작 — 조회 · 등록 · 수정 · 삭제(role_group_menus 의 is_readable · …). 목록 하나에서 타입이 나온다. */
export const MENU_OPS = ['read', 'create', 'update', 'delete'] as const;
export type MenuOp = (typeof MENU_OPS)[number];
export type CellFlags = Record<MenuOp, boolean>;
export const NO_FLAGS: Readonly<CellFlags> = Object.freeze({
  read: false,
  create: false,
  update: false,
  delete: false,
});

/**
 * 메뉴 칸을 바꿀 수 없는 이유. API 전용 enum PlatformRoleMenuBlockReason — 값 · 한글 · 순서는 이 상수 하나에서
 * 나온다(GET /enums). 순서는 판정 순서다 — 앞의 것이 걸리면 뒤는 보지 않는다.
 */
export const MENU_BLOCK_REASON_LABELS = {
  PM_FIXED: '플랫폼 마스터 권한은 전체 메뉴 허용 고정',
  READ_ONLY: '권한 관리 수정 권한 없음',
  SELF_LINKED: '본인이 연결된 권한',
  PLATFORM_MENU_FOR_BP:
    'BP 마스터·가맹 마스터 권한에는 플랫폼 관리 메뉴를 줄 수 없음',
  OUT_OF_SCOPE: '본인 권한 범위 밖',
} as const;
export type CellBlockReason = keyof typeof MENU_BLOCK_REASON_LABELS;
export const MENU_BLOCK_REASONS = Object.keys(
  MENU_BLOCK_REASON_LABELS,
) as readonly CellBlockReason[];

/** 플랫폼 관리 사이트의 서비스 코드(공통코드 SERVICE). BP 쪽 고정 권한에는 이 서비스의 메뉴를 줄 수 없다. */
export const PLATFORM_SERVICE = 'PLATFORM';

export interface MenuNode {
  menuId: number;
  parentMenuId: number | null;
  menuCode: string;
  serviceCode: string;
  name: string;
  depth: number;
  sortOrder: number;
  /** 사용 상태 — ACTIVE · INACTIVE */
  status: string;
  /**
   * 화면 주소(menus.url). 묶음 메뉴와 일부 사용중지 메뉴는 없다. 권한 관리 화면이 가드와 같은 키로 호출자의 권한 관리
   * 메뉴를 찾는 데 쓴다
   */
  url: string | null;
}

export type CellChange = {
  menuId: number;
  op: MenuOp;
  from: boolean;
  to: boolean;
};

/**
 * 메뉴 등록 팝업에 보이는 메뉴. 지우지 않은 메뉴를 받아 사용 중이고, 서비스가 사용 중이고, 상위가 모두 보이는
 * 것만 남긴다 — 사용중지 상위 아래의 하위, 상위가 지워져 뿌리에서 닿지 않는 메뉴는 빠진다(S-EFQREM).
 * 순서는 받은 그대로다.
 */
export function visibleMenus(
  menus: MenuNode[],
  activeServices: Set<string>,
): MenuNode[] {
  const byId = new Map(menus.map((m) => [m.menuId, m]));
  const memo = new Map<number, boolean>();
  const isVisible = (menu: MenuNode, seen: Set<number>): boolean => {
    const known = memo.get(menu.menuId);
    if (known !== undefined) return known;
    let visible =
      menu.status === 'ACTIVE' && activeServices.has(menu.serviceCode);
    if (visible && menu.parentMenuId !== null) {
      const parent = byId.get(menu.parentMenuId);
      // 상위가 고리를 이루면(데이터 오류) 보이지 않는 것으로 둔다.
      visible =
        parent !== undefined &&
        !seen.has(parent.menuId) &&
        isVisible(parent, new Set(seen).add(menu.menuId));
    }
    memo.set(menu.menuId, visible);
    return visible;
  };
  return menus.filter((m) => isVisible(m, new Set()));
}

/** 묶음 메뉴 — 보이는 하위가 있는 메뉴. 그 자체로 열 화면이 없어 칸은 하위에서 정해진다. */
export function groupMenuIds(visible: MenuNode[]): Set<number> {
  const ids = new Set(visible.map((m) => m.menuId));
  return new Set(
    visible
      .map((m) => m.parentMenuId)
      .filter((id): id is number => id !== null && ids.has(id)),
  );
}

/** 등록 · 수정 · 삭제가 켜졌는데 조회가 꺼졌는가. 조회 없이 쓰는 권한은 없다. */
export function hasWriteWithoutRead(flags: CellFlags): boolean {
  return !flags.read && (flags.create || flags.update || flags.delete);
}

/**
 * 묶음 메뉴의 칸을 하위에서 다시 정한다 — 보이는 하위에 조회가 하나라도 있으면 조회만 켜고, 등록 · 수정 · 삭제는
 * 끈다(1팀 초기 데이터와 같다). 아래 단계부터 올라가므로 2단계 묶음이 1단계 묶음에 반영된다. 받은 Map 은 그대로
 * 두고 새 Map 을 돌려준다.
 */
export function normalizeGroups(
  visible: MenuNode[],
  after: Map<number, CellFlags>,
): Map<number, CellFlags> {
  const result = new Map(after);
  const groups = groupMenuIds(visible);
  const childrenOf = new Map<number, number[]>();
  for (const m of visible)
    if (m.parentMenuId !== null && groups.has(m.parentMenuId))
      childrenOf.set(m.parentMenuId, [
        ...(childrenOf.get(m.parentMenuId) ?? []),
        m.menuId,
      ]);
  const ordered = visible
    .filter((m) => groups.has(m.menuId))
    .sort((a, b) => b.depth - a.depth);
  for (const group of ordered) {
    const read = (childrenOf.get(group.menuId) ?? []).some(
      (id) => result.get(id)?.read ?? false,
    );
    result.set(group.menuId, { ...NO_FLAGS, read });
  }
  return result;
}

/** 두 상태 사이에 바뀐 칸. 행이 없는 메뉴는 모두 꺼진 것으로 본다. 메뉴 순서 · 동작 순서대로. */
export function changedCells(
  before: Map<number, CellFlags>,
  after: Map<number, CellFlags>,
  menuIds: number[],
): CellChange[] {
  return menuIds.flatMap((menuId) => {
    const from = before.get(menuId) ?? NO_FLAGS;
    const to = after.get(menuId) ?? NO_FLAGS;
    return MENU_OPS.filter((op) => from[op] !== to[op]).map((op) => ({
      menuId,
      op,
      from: from[op],
      to: to[op],
    }));
  });
}

/** 고정 권한에서 회수한 동작을 하위 권한 그룹의 같은 메뉴에서도 끈다. 조회를 회수하면 그 줄 전체가 꺼진다. */
export function cascadeFlags(
  current: CellFlags,
  revoked: Set<MenuOp>,
): CellFlags {
  if (revoked.has('read')) return { ...NO_FLAGS };
  const next = { ...current };
  for (const op of revoked) next[op] = false;
  return next;
}

export interface CellContext {
  /** 대상 권한의 유형 — PM · PA · BM · FM */
  targetRoleType: string;
  /** 호출자의 권한 그룹이 대상인가 */
  isSelfLinked: boolean;
  /** 호출자가 권한 관리 메뉴(`/platform-role-groups`, 현재 MN000214) 수정 권한을 가졌는가 */
  canUpdate: boolean;
  callerRoleType: string;
  /** 호출자 본인 권한 그룹의 같은 메뉴 칸. 행이 없으면 undefined. */
  callerGrant: CellFlags | undefined;
  serviceCode: string;
  /** 대상 권한의 이 메뉴 줄의 지금 값 */
  current: CellFlags;
}

/**
 * 칸 하나를 바꿀 수 없는 이유. 없으면 null. 목업 blockOf 와 같은 순서다 — 플랫폼 마스터 고정, 조회만,
 * 본인 연결, BP 쪽 고정 권한의 플랫폼 메뉴, 본인 범위 상한. 본인 범위 상한은 플랫폼 관리자(PA) 쪽 권한을
 * PA 호출자가 볼 때만 건다 — PM 호출자는 상한이 없고 BP · 가맹 마스터 권한에는 걸지 않는다(SYSTEM-6).
 * BP 쪽 고정 권한의 플랫폼 메뉴는 켜는 것만 막는다 — 잘못 들어간 칸을 끌 수 있게, 저장과 같은 판정이다.
 * 켜진 조회 칸은 끄면 등록 · 수정 · 삭제도 같이 꺼지므로, 그중 켜진 칸이 상한 밖이면 조회 칸도 막는다(저장이 400).
 */
export function cellBlock(
  ctx: CellContext,
  op: MenuOp,
): CellBlockReason | null {
  if (ctx.targetRoleType === 'PM') return 'PM_FIXED';
  if (!ctx.canUpdate) return 'READ_ONLY';
  if (ctx.isSelfLinked) return 'SELF_LINKED';
  if (
    isBpMaster(ctx.targetRoleType) &&
    ctx.serviceCode === PLATFORM_SERVICE &&
    !ctx.current[op]
  )
    return 'PLATFORM_MENU_FOR_BP';
  if (ctx.targetRoleType === 'PA' && ctx.callerRoleType === 'PA') {
    const allowed = (o: MenuOp) => ctx.callerGrant?.[o] ?? false;
    if (!allowed(op)) return 'OUT_OF_SCOPE';
    if (
      op === 'read' &&
      ctx.current.read &&
      MENU_OPS.some((o) => ctx.current[o] && !allowed(o))
    )
      return 'OUT_OF_SCOPE';
  }
  return null;
}

/** BP 쪽 고정 권한의 유형 — BP 마스터 · 가맹 마스터. 그 메뉴 설정이 BA · FA 그룹의 상한이 된다. */
export type BpMasterType = 'BM' | 'FM';

/** 타입 가드 — 회수 연쇄처럼 BM · FM 만 받는 함수는 이 검사를 거친 값만 받는다(빠뜨리면 컴파일 오류). */
export function isBpMaster(roleType: string): roleType is BpMasterType {
  return roleType === 'BM' || roleType === 'FM';
}
