import {
  type CellFlags,
  cascadeFlags,
  cellBlock,
  changedCells,
  groupMenuIds,
  hasWriteWithoutRead,
  type MenuNode,
  NO_FLAGS,
  normalizeGroups,
  visibleMenus,
} from './role-menu-rules';

const ALL: CellFlags = { read: true, create: true, update: true, delete: true };
const R: CellFlags = { ...NO_FLAGS, read: true };

function menu(
  menuId: number,
  parentMenuId: number | null,
  extra: Partial<MenuNode> = {},
): MenuNode {
  return {
    menuId,
    parentMenuId,
    menuCode: `MN${String(menuId).padStart(6, '0')}`,
    serviceCode: 'PLATFORM',
    name: `메뉴${menuId}`,
    depth: parentMenuId === null ? 1 : 2,
    sortOrder: menuId,
    status: 'ACTIVE',
    ...extra,
  };
}

describe('visibleMenus', () => {
  const services = new Set(['PLATFORM', 'WHALE_ERP']);

  it('사용 중인 메뉴만 남긴다', () => {
    const menus = [menu(1, null), menu(2, null, { status: 'INACTIVE' })];
    expect(visibleMenus(menus, services).map((m) => m.menuId)).toEqual([1]);
  });

  it('사용중지 상위 아래의 하위 메뉴는 사용 중이어도 빠진다 — 손자까지', () => {
    const menus = [
      menu(1, null, { status: 'INACTIVE' }),
      menu(2, 1),
      menu(3, 2, { depth: 3 }),
      menu(4, null),
    ];
    expect(visibleMenus(menus, services).map((m) => m.menuId)).toEqual([4]);
  });

  it('사용중지 서비스의 메뉴는 빠진다', () => {
    const menus = [menu(1, null, { serviceCode: 'POS' }), menu(2, null)];
    expect(visibleMenus(menus, services).map((m) => m.menuId)).toEqual([2]);
  });

  it('상위가 목록에 없으면(지운 상위) 뿌리에서 닿지 않아 빠진다', () => {
    const menus = [menu(2, 99), menu(3, null)];
    expect(visibleMenus(menus, services).map((m) => m.menuId)).toEqual([3]);
  });
});

describe('groupMenuIds', () => {
  it('보이는 하위가 있는 메뉴만 묶음이다', () => {
    const visible = [menu(1, null), menu(2, 1), menu(3, null)];
    expect([...groupMenuIds(visible)]).toEqual([1]);
  });
});

describe('hasWriteWithoutRead', () => {
  it.each([
    [{ ...NO_FLAGS, create: true }, true],
    [{ ...NO_FLAGS, update: true }, true],
    [{ ...NO_FLAGS, delete: true }, true],
    [ALL, false],
    [R, false],
    [NO_FLAGS, false],
  ])('%o → %s', (flags, expected) => {
    expect(hasWriteWithoutRead(flags)).toBe(expected);
  });
});

describe('normalizeGroups', () => {
  // 1(묶음) ─ 2(묶음) ─ 3, 1 ─ 4
  const visible = [
    menu(1, null),
    menu(2, 1),
    menu(3, 2, { depth: 3 }),
    menu(4, 1),
  ];

  it('하위에 조회가 하나라도 있으면 묶음은 조회만 켜진다 — 클라이언트가 보낸 값은 무시', () => {
    const after = new Map<number, CellFlags>([
      [1, { ...NO_FLAGS, create: true, update: true }],
      [2, NO_FLAGS],
      [3, R],
      [4, NO_FLAGS],
    ]);
    const result = normalizeGroups(visible, after);
    expect(result.get(2)).toEqual(R);
    expect(result.get(1)).toEqual(R);
    expect(result.get(3)).toEqual(R);
  });

  it('하위가 모두 꺼지면 묶음도 꺼진다', () => {
    const after = new Map<number, CellFlags>([
      [1, ALL],
      [2, ALL],
      [3, NO_FLAGS],
      [4, NO_FLAGS],
    ]);
    const result = normalizeGroups(visible, after);
    expect(result.get(1)).toEqual(NO_FLAGS);
    expect(result.get(2)).toEqual(NO_FLAGS);
  });

  it('행이 없는 하위는 꺼진 것으로 본다', () => {
    const after = new Map<number, CellFlags>([[4, ALL]]);
    const result = normalizeGroups(visible, after);
    expect(result.get(1)).toEqual(R);
    expect(result.get(2)).toEqual(NO_FLAGS);
  });
});

describe('changedCells', () => {
  it('바뀐 칸만 메뉴 · 동작마다 돌려준다', () => {
    const before = new Map<number, CellFlags>([[1, R]]);
    const after = new Map<number, CellFlags>([
      [1, { ...R, create: true }],
      [2, NO_FLAGS],
    ]);
    expect(changedCells(before, after, [1, 2])).toEqual([
      { menuId: 1, op: 'create', from: false, to: true },
    ]);
  });

  it('없는 행은 모두 꺼진 것으로 본다', () => {
    const after = new Map<number, CellFlags>([[3, R]]);
    expect(changedCells(new Map(), after, [3])).toEqual([
      { menuId: 3, op: 'read', from: false, to: true },
    ]);
  });
});

describe('cascadeFlags', () => {
  it('회수한 동작만 끈다', () => {
    expect(cascadeFlags(ALL, new Set(['delete']))).toEqual({
      ...ALL,
      delete: false,
    });
  });

  it('조회를 회수하면 등록 · 수정 · 삭제도 끈다', () => {
    expect(cascadeFlags(ALL, new Set(['read']))).toEqual(NO_FLAGS);
  });
});

describe('cellBlock', () => {
  const base = {
    targetRoleType: 'PA',
    isSelfLinked: false,
    canUpdate: true,
    callerRoleType: 'PA',
    callerGrant: ALL,
    serviceCode: 'PLATFORM',
    current: NO_FLAGS,
  };

  it('막힘이 없으면 null', () => {
    expect(cellBlock(base, 'read')).toBeNull();
  });

  it('플랫폼 마스터 권한은 무엇보다 먼저 PM_FIXED', () => {
    expect(
      cellBlock(
        { ...base, targetRoleType: 'PM', canUpdate: false, isSelfLinked: true },
        'read',
      ),
    ).toBe('PM_FIXED');
  });

  it('수정 권한이 없으면 READ_ONLY — 본인 연결보다 앞선다', () => {
    expect(
      cellBlock({ ...base, canUpdate: false, isSelfLinked: true }, 'read'),
    ).toBe('READ_ONLY');
  });

  it('본인이 연결된 권한이면 SELF_LINKED', () => {
    expect(cellBlock({ ...base, isSelfLinked: true }, 'read')).toBe(
      'SELF_LINKED',
    );
  });

  it('BP · 가맹 마스터의 플랫폼 메뉴도 켜져 있으면 끌 수 있다 — 저장이 끄기는 받으므로', () => {
    expect(
      cellBlock({ ...base, targetRoleType: 'BM', current: R }, 'read'),
    ).toBeNull();
  });

  it('BP · 가맹 마스터의 꺼진 플랫폼 메뉴는 PLATFORM_MENU_FOR_BP', () => {
    expect(cellBlock({ ...base, targetRoleType: 'BM' }, 'read')).toBe(
      'PLATFORM_MENU_FOR_BP',
    );
    expect(
      cellBlock(
        { ...base, targetRoleType: 'FM', serviceCode: 'WHALE_ERP' },
        'read',
      ),
    ).toBeNull();
  });

  it('PA 호출자가 PA 권한을 볼 때 본인에게 없는 칸은 OUT_OF_SCOPE', () => {
    const callerGrant = { ...R };
    expect(cellBlock({ ...base, callerGrant }, 'read')).toBeNull();
    expect(cellBlock({ ...base, callerGrant }, 'create')).toBe('OUT_OF_SCOPE');
    expect(cellBlock({ ...base, callerGrant: undefined }, 'read')).toBe(
      'OUT_OF_SCOPE',
    );
  });

  it('조회 칸은 켜진 등록 · 수정 · 삭제 중 상한 밖이 있으면 막힌다 — 끄면 그 칸도 같이 꺼져 저장이 400 이므로', () => {
    const callerGrant = { ...NO_FLAGS, read: true, update: true };
    expect(cellBlock({ ...base, callerGrant, current: ALL }, 'read')).toBe(
      'OUT_OF_SCOPE',
    );
    expect(
      cellBlock(
        {
          ...base,
          callerGrant,
          current: { ...NO_FLAGS, read: true, update: true },
        },
        'read',
      ),
    ).toBeNull();
  });

  it('PM 호출자에게는 상한이 없다', () => {
    expect(
      cellBlock(
        { ...base, callerRoleType: 'PM', callerGrant: undefined },
        'delete',
      ),
    ).toBeNull();
  });

  it('BP · 가맹 마스터 권한에는 본인 상한을 걸지 않는다', () => {
    expect(
      cellBlock(
        {
          ...base,
          targetRoleType: 'BM',
          serviceCode: 'WHALE_ERP',
          callerGrant: undefined,
        },
        'delete',
      ),
    ).toBeNull();
  });
});
