import { buildMenuTree, MenuRow, MenuPermissionRow } from './menu-tree';

const menu = (
  menuId: number,
  parentMenuId: number | null,
  sortOrder = 0,
  depth = parentMenuId === null ? 1 : 2,
): MenuRow => ({
  menuId,
  parentMenuId,
  menuCode: `MN${String(menuId).padStart(6, '0')}`,
  name: `메뉴${menuId}`,
  url: `/m/${menuId}`,
  depth,
  sortOrder,
});
const read = (
  menuId: number,
  over: Partial<MenuPermissionRow> = {},
): MenuPermissionRow => ({
  menuId,
  isReadable: true,
  isCreatable: false,
  isUpdatable: false,
  isDeletable: false,
  ...over,
});
const codes = (nodes: { menuCode: string; children: unknown[] }[]): unknown =>
  nodes.map((n) => [n.menuCode, codes(n.children as never)]);

describe('buildMenuTree', () => {
  it('조회 권한이 있는 메뉴만 남기고 CRUD 를 붙인다', () => {
    const tree = buildMenuTree(
      [menu(1, null), menu(2, 1), menu(3, 1)],
      [read(1), read(2, { isUpdatable: true })],
    );
    expect(tree).toEqual([
      {
        menuCode: 'MN000001',
        name: '메뉴1',
        url: '/m/1',
        depth: 1,
        permission: { read: true, create: false, update: false, delete: false },
        children: [
          {
            menuCode: 'MN000002',
            name: '메뉴2',
            url: '/m/2',
            depth: 2,
            permission: {
              read: true,
              create: false,
              update: true,
              delete: false,
            },
            children: [],
          },
        ],
      },
    ]);
  });

  it('하위가 보이면 조회 권한 없는 상위도 길로 넣는다(권한은 모두 false)', () => {
    const tree = buildMenuTree([menu(1, null), menu(2, 1)], [read(2)]);
    expect(tree[0].permission).toEqual({
      read: false,
      create: false,
      update: false,
      delete: false,
    });
    expect(codes(tree)).toEqual([['MN000001', [['MN000002', []]]]]);
  });

  it('3단계까지 순서대로 — 표시 순서, 같으면 id', () => {
    const tree = buildMenuTree(
      [
        menu(1, null, 2),
        menu(4, null, 1),
        menu(2, 1, 0),
        menu(3, 2, 0, 3),
        menu(5, 4, 0),
      ],
      [read(1), read(2), read(3), read(4), read(5)],
    );
    expect(codes(tree)).toEqual([
      ['MN000004', [['MN000005', []]]],
      ['MN000001', [['MN000002', [['MN000003', []]]]]],
    ]);
  });

  it('상위가 목록에 없으면(사용중지 · 삭제) 그 아래도 보이지 않는다', () => {
    const tree = buildMenuTree([menu(2, 1), menu(3, null)], [read(2), read(3)]);
    expect(codes(tree)).toEqual([['MN000003', []]]);
  });

  it('권한이 없으면 빈 목록', () => {
    expect(buildMenuTree([menu(1, null)], [])).toEqual([]);
  });
});
