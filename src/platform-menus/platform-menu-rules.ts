import { BadRequestException, ConflictException } from '@nestjs/common';
import type { UseStatus } from '@prisma/client';

/**
 * 플랫폼 메뉴 관리(MN000215)의 순수 규칙 — 코드 채번, URL 겹침, 숨김 판정, 옮기기 계획. DB 를 모르는 함수로 두어
 * 서비스가 같은 판정을 쓰고 단위 테스트로 경계를 고정한다.
 */

/** 메뉴는 서비스 단위로 최대 3단계(F-CWWQUR). DB CHECK menus_depth_range 와 같다. */
export const MAX_MENU_DEPTH = 3;

export interface MenuRow {
  menuId: number;
  parentMenuId: number | null;
  sortOrder: number;
  depth: number;
  status: UseStatus;
}

/** 옮긴 뒤 값이 바뀌는 행. */
export interface MenuPlacement {
  menuId: number;
  parentMenuId: number | null;
  sortOrder: number;
  depth: number;
}

export const SELF_OR_DESCENDANT =
  '메뉴를 자기 자신이나 하위 메뉴 아래로 옮길 수 없습니다.';
export const TOO_DEEP = '메뉴는 최대 3단계까지만 둘 수 있습니다.';
export const OTHER_SERVICE = '같은 서비스 안에서만 옮길 수 있습니다.';

/**
 * 다음 메뉴 코드 — MN + 6자리. 서비스를 가리지 않고 지운 메뉴까지 포함한 가장 큰 코드의 다음이라, 지운 번호를
 * 다시 쓰지 않는다(PL-EIMSQF). 물리 삭제된 번호(MN000007 · 008)보다 큰 코드가 이미 있어 그 번호도 다시 나오지 않는다.
 */
export function nextMenuCode(last: string | null): string {
  const next = (last ? Number(last.slice(2)) : 0) + 1;
  if (next > 999_999)
    throw new ConflictException('메뉴 코드를 더 만들 수 없습니다.');
  return `MN${String(next).padStart(6, '0')}`;
}

/**
 * 두 URL 이 같거나 한쪽이 다른 쪽 아래 경로인가. 관리자 웹은 URL 접두어로 메뉴 권한을 가르므로, 겹치면 위 메뉴의
 * 권한만으로 아래 화면이 열린다(3팀 마이그레이션 DO 블록과 같은 규칙).
 */
export function urlsOverlap(a: string, b: string): boolean {
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** 형제 — 같은 상위 아래 메뉴를 순서 · id 순으로. */
export function siblingsOf(
  menus: MenuRow[],
  parentMenuId: number | null,
): MenuRow[] {
  return menus
    .filter((m) => m.parentMenuId === parentMenuId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.menuId - b.menuId);
}

/** 자기 자신과 모든 하위의 id. */
export function subtreeIds(menus: MenuRow[], menuId: number): Set<number> {
  const ids = new Set([menuId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of menus)
      if (
        m.parentMenuId !== null &&
        ids.has(m.parentMenuId) &&
        !ids.has(m.menuId)
      ) {
        ids.add(m.menuId);
        grew = true;
      }
  }
  return ids;
}

/** 자신부터 가장 깊은 하위까지의 단계 수 — 잎은 1. */
export function subtreeHeight(menus: MenuRow[], menuId: number): number {
  const children = menus.filter((m) => m.parentMenuId === menuId);
  return (
    1 + Math.max(0, ...children.map((c) => subtreeHeight(menus, c.menuId)))
  );
}

/**
 * 사용자 화면에 보이지 않는 메뉴 — 서비스가 사용중지거나, 자신이나 조상 중 하나가 사용중지. 상위를 끄면 하위의 상태
 * 값은 그대로 두고 함께 빠진다(S-GXMZOU).
 */
export function hiddenMenuIds(
  menus: MenuRow[],
  serviceActive: boolean,
): Set<number> {
  if (!serviceActive) return new Set(menus.map((m) => m.menuId));
  const byId = new Map(menus.map((m) => [m.menuId, m]));
  const hidden = new Set<number>();
  for (const m of menus) {
    let cur: MenuRow | undefined = m;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.menuId)) {
      if (cur.status !== 'ACTIVE') {
        hidden.add(m.menuId);
        break;
      }
      seen.add(cur.menuId);
      cur = cur.parentMenuId === null ? undefined : byId.get(cur.parentMenuId);
    }
  }
  return hidden;
}

/**
 * 메뉴를 다른 자리로 — 새 상위(null 이면 최상위)의 index 번째(0부터, 넘으면 맨 끝). 하위가 함께 가고, 옛 상위와 새
 * 상위의 형제 순서를 1부터 다시 매기며, 옮긴 메뉴와 하위의 단계를 다시 센다. 값이 바뀌는 행만 돌려준다.
 * `menus` 는 그 서비스의 지우지 않은 메뉴 전부여야 한다 — 새 상위가 없으면 다른 서비스로 본다.
 */
export function planMove(
  menus: MenuRow[],
  menuId: number,
  parentMenuId: number | null,
  index: number,
): MenuPlacement[] {
  const byId = new Map(menus.map((m) => [m.menuId, m]));
  const moving = byId.get(menuId);
  // 서비스가 먼저 찾아 404 를 낸 뒤 부르므로 여기 오면 호출 쪽 잘못이다 — TypeError 대신 원인을 적는다.
  if (!moving)
    throw new Error(`옮길 메뉴(${menuId})가 그 서비스의 메뉴 목록에 없습니다`);
  const parent = parentMenuId === null ? null : byId.get(parentMenuId);
  if (parent === undefined) throw new BadRequestException(OTHER_SERVICE);
  const subtree = subtreeIds(menus, menuId);
  if (parent && subtree.has(parent.menuId))
    throw new BadRequestException(SELF_OR_DESCENDANT);
  const newDepth = parent ? parent.depth + 1 : 1;
  if (newDepth + subtreeHeight(menus, menuId) - 1 > MAX_MENU_DEPTH)
    throw new BadRequestException(TOO_DEEP);

  const next = new Map<number, MenuPlacement>(
    menus.map((m) => [
      m.menuId,
      {
        menuId: m.menuId,
        parentMenuId: m.parentMenuId,
        sortOrder: m.sortOrder,
        depth: m.depth,
      },
    ]),
  );
  const oldSiblings = siblingsOf(menus, moving.parentMenuId).filter(
    (m) => m.menuId !== menuId,
  );
  const newSiblings = siblingsOf(menus, parentMenuId).filter(
    (m) => m.menuId !== menuId,
  );
  newSiblings.splice(
    Math.min(Math.max(index, 0), newSiblings.length),
    0,
    moving,
  );
  oldSiblings.forEach((m, i) => (next.get(m.menuId)!.sortOrder = i + 1));
  newSiblings.forEach((m, i) => (next.get(m.menuId)!.sortOrder = i + 1));
  next.get(menuId)!.parentMenuId = parentMenuId;
  const shift = newDepth - moving.depth;
  for (const id of subtree) next.get(id)!.depth += shift;

  return [...next.values()].filter((p) => {
    const m = byId.get(p.menuId)!;
    return (
      p.parentMenuId !== m.parentMenuId ||
      p.sortOrder !== m.sortOrder ||
      p.depth !== m.depth
    );
  });
}
