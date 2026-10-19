import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  hiddenMenuIds,
  type MenuRow,
  nextMenuCode,
  planMove,
  subtreeHeight,
  urlsOverlap,
} from './platform-menu-rules';

/**
 * 표본 — 1 시스템관리 ─ 2 관리자 관리 · 3 권한 관리(─ 4 권한 상세), 5 커뮤니티(사용중지) ─ 6 공지사항, 7 회원관리.
 * 최상위 순서 1 · 5 · 7, 1 의 하위 순서 2 · 3.
 */
function row(
  menuId: number,
  parentMenuId: number | null,
  sortOrder: number,
  depth: number,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
): MenuRow {
  return { menuId, parentMenuId, sortOrder, depth, status };
}
const MENUS: MenuRow[] = [
  row(1, null, 1, 1),
  row(2, 1, 1, 2),
  row(3, 1, 2, 2),
  row(4, 3, 1, 3),
  row(5, null, 2, 1, 'INACTIVE'),
  row(6, 5, 1, 2),
  row(7, null, 3, 1),
];

describe('nextMenuCode', () => {
  it('지운 것까지 포함한 가장 큰 코드의 다음 — 없으면 MN000001', () => {
    expect(nextMenuCode(null)).toBe('MN000001');
    expect(nextMenuCode('MN000222')).toBe('MN000223');
  });

  it('999999 를 넘으면 409', () => {
    expect(() => nextMenuCode('MN999999')).toThrow(ConflictException);
  });
});

describe('urlsOverlap', () => {
  it.each([
    ['/stores', '/stores', true],
    ['/stores', '/stores/inspections', true],
    ['/stores/inspections', '/stores', true],
    ['/stores', '/stores-x', false],
    ['/staff', '/staff-members', false],
    ['/a/b', '/a/c', false],
  ])('%s 와 %s → %s', (a, b, expected) => {
    expect(urlsOverlap(a, b)).toBe(expected);
  });
});

describe('subtreeHeight', () => {
  it('잎은 1, 하위가 있으면 가장 깊은 하위까지의 단계 수', () => {
    expect(subtreeHeight(MENUS, 4)).toBe(1);
    expect(subtreeHeight(MENUS, 3)).toBe(2);
    expect(subtreeHeight(MENUS, 1)).toBe(3);
  });
});

describe('hiddenMenuIds', () => {
  it('자신이나 조상이 사용중지면 숨는다 — 하위의 상태 값은 그대로라도', () => {
    expect([...hiddenMenuIds(MENUS, true)].sort()).toEqual([5, 6]);
  });

  it('서비스가 사용중지면 모두 숨는다', () => {
    expect(hiddenMenuIds(MENUS, false).size).toBe(MENUS.length);
  });

  it('두 단계 위가 사용중지여도 숨는다 — 바로 위 상위만 보지 않는다', () => {
    const menus = [...MENUS, row(8, 6, 1, 3)];
    expect([...hiddenMenuIds(menus, true)].sort()).toEqual([5, 6, 8]);
  });
});

describe('planMove', () => {
  const byId = (plan: ReturnType<typeof planMove>) =>
    Object.fromEntries(plan.map((p) => [p.menuId, p]));

  it('다른 상위의 맨 앞으로 — 옛 형제와 새 형제의 순서를 1부터 다시 매기고, 바뀐 행만 준다', () => {
    const plan = byId(planMove(MENUS, 2, 7, 0));
    expect(plan[2]).toEqual({
      menuId: 2,
      parentMenuId: 7,
      sortOrder: 1,
      depth: 2,
    });
    expect(plan[3]).toEqual({
      menuId: 3,
      parentMenuId: 1,
      sortOrder: 1,
      depth: 2,
    }); // 옛 형제가 당겨진다
    expect(plan[4]).toBeUndefined(); // 바뀐 것이 없다
  });

  it('하위가 함께 옮겨 가고 단계가 다시 계산된다', () => {
    const plan = byId(planMove(MENUS, 3, null, 0));
    expect(plan[3]).toMatchObject({
      parentMenuId: null,
      sortOrder: 1,
      depth: 1,
    });
    expect(plan[4]).toMatchObject({ parentMenuId: 3, depth: 2 });
    expect(plan[1]).toMatchObject({ sortOrder: 2 });
    expect(plan[7]).toMatchObject({ sortOrder: 4 });
  });

  it('같은 상위 안에서 순서만 바꾼다 — 자리 수를 넘는 index 는 맨 끝', () => {
    const plan = byId(planMove(MENUS, 1, null, 99));
    expect(plan[1]).toMatchObject({ sortOrder: 3 });
    expect(plan[5]).toMatchObject({ sortOrder: 1 });
    expect(plan[7]).toMatchObject({ sortOrder: 2 });
  });

  it('같은 상위 안의 중간 자리로 — index 는 자기 자신을 뺀 형제 목록 기준', () => {
    const plan = byId(planMove(MENUS, 1, null, 1));
    expect(plan[5]).toMatchObject({ sortOrder: 1 });
    expect(plan[1]).toMatchObject({ sortOrder: 2 });
    expect(plan[7]).toBeUndefined(); // 3 그대로
  });

  it('형제는 배열 순서가 아니라 sortOrder 순(같으면 menuId 순)으로 다시 매긴다', () => {
    // 배열 순서 9 · 8 · 10, sortOrder 순서 8 · 10 · 9, 11 과 12 는 sortOrder 가 같다.
    const menus = [
      row(9, null, 3, 1),
      row(8, null, 1, 1),
      row(10, null, 2, 1),
      row(12, null, 4, 1),
      row(11, null, 4, 1),
    ];
    const plan = byId(planMove(menus, 8, null, 99));
    expect(plan[10]).toMatchObject({ sortOrder: 1 });
    expect(plan[9]).toMatchObject({ sortOrder: 2 });
    expect(plan[11]).toMatchObject({ sortOrder: 3 });
    expect(plan[12]).toBeUndefined(); // 4 그대로 — 같은 4 인 11 이 id 순으로 앞선다
    expect(plan[8]).toMatchObject({ sortOrder: 5 });
  });

  it('옮길 메뉴가 목록에 없으면 호출 쪽 잘못이라 원인을 적어 던진다', () => {
    expect(() => planMove(MENUS, 99, null, 0)).toThrow(
      '옮길 메뉴(99)가 그 서비스의 메뉴 목록에 없습니다',
    );
  });

  it('사용중지 상위 아래로도 옮길 수 있다', () => {
    expect(byId(planMove(MENUS, 7, 5, 0))[7]).toMatchObject({
      parentMenuId: 5,
      depth: 2,
    });
  });

  it('제자리면 바뀐 행이 없다', () => {
    expect(planMove(MENUS, 3, 1, 1)).toEqual([]);
  });

  it.each([
    [
      '자기 자신 아래',
      3,
      3,
      '메뉴를 자기 자신이나 하위 메뉴 아래로 옮길 수 없습니다',
    ],
    [
      '자기 하위 아래',
      1,
      3,
      '메뉴를 자기 자신이나 하위 메뉴 아래로 옮길 수 없습니다',
    ],
    [
      '3단계를 넘는다(하위 높이 포함)',
      3,
      2,
      '메뉴는 최대 3단계까지만 둘 수 있습니다',
    ],
    ['3단계 메뉴 아래', 7, 4, '메뉴는 최대 3단계까지만 둘 수 있습니다'],
    [
      '다른 서비스(목록에 없는 상위)',
      7,
      99,
      '같은 서비스 안에서만 옮길 수 있습니다',
    ],
  ])('%s 는 400', (_, menuId, parentId, message) => {
    expect(() => planMove(MENUS, menuId, parentId, 0)).toThrow(
      new BadRequestException(message),
    );
  });
});
