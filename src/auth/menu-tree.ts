import { AdminMenuDto } from './dto/admin-login-info.response.dto';

export interface MenuRow {
  menuId: number;
  parentMenuId: number | null;
  menuCode: string;
  serviceCode: string;
  name: string;
  url: string | null;
  depth: number;
  sortOrder: number;
}

export interface MenuPermissionRow {
  menuId: number;
  isReadable: boolean;
  isCreatable: boolean;
  isUpdatable: boolean;
  isDeletable: boolean;
}

/**
 * 보이는 메뉴 트리. `menus` 는 사용 중인 메뉴만 받는다 — 상위가 빠진 메뉴는 뿌리에서 닿지 않아 함께 빠진다.
 * 조회 권한이 있는 메뉴와, 그 메뉴로 가는 길인 상위 메뉴만 남긴다. 표시 순서, 같으면 id 순이다.
 */
export function buildMenuTree(
  menus: MenuRow[],
  permissions: MenuPermissionRow[],
): AdminMenuDto[] {
  const permissionOf = new Map(permissions.map((p) => [p.menuId, p]));
  const childrenOf = new Map<number | null, MenuRow[]>();
  for (const menu of [...menus].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.menuId - b.menuId,
  ))
    childrenOf.set(menu.parentMenuId, [
      ...(childrenOf.get(menu.parentMenuId) ?? []),
      menu,
    ]);

  const build = (parentId: number | null): AdminMenuDto[] =>
    (childrenOf.get(parentId) ?? []).flatMap((menu) => {
      const children = build(menu.menuId);
      const p = permissionOf.get(menu.menuId);
      if (!p?.isReadable && children.length === 0) return [];
      return [
        {
          menuCode: menu.menuCode,
          serviceCode: menu.serviceCode,
          name: menu.name,
          url: menu.url,
          depth: menu.depth,
          permission: {
            read: p?.isReadable ?? false,
            create: p?.isCreatable ?? false,
            update: p?.isUpdatable ?? false,
            delete: p?.isDeletable ?? false,
          },
          children,
        },
      ];
    });
  return build(null);
}
