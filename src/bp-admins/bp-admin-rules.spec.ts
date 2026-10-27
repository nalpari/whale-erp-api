import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  actionsOf,
  assertSelfEdit,
  type BpAdminCaller,
  type BpAdminTarget,
  canSee,
  creatableRoles,
  planStores,
  shrinkCascade,
  sideOf,
} from './bp-admin-rules';

// 본사(BM · BA · 플랫폼) · 가맹 마스터 · 가맹 관리자. 점포 1~4 직영, 5~8 가맹(가맹 마스터 20 담당).
const hqAll: BpAdminCaller = {
  adminAccountId: 1,
  side: 'HQ',
  isAllStores: true,
  storeIds: [1, 2, 3, 4, 5, 6, 7, 8],
};
const hqPart: BpAdminCaller = {
  adminAccountId: 2,
  side: 'HQ',
  isAllStores: false,
  storeIds: [1, 2],
};
const fm: BpAdminCaller = {
  adminAccountId: 20,
  side: 'FM',
  isAllStores: false,
  storeIds: [5, 6, 7, 8],
};
const fa: BpAdminCaller = {
  adminAccountId: 30,
  side: 'FA',
  isAllStores: false,
  storeIds: [6],
};

const target = (o: Partial<BpAdminTarget> = {}): BpAdminTarget => ({
  adminAccountId: 9,
  roleTypeCode: 'BA',
  isAllStores: false,
  storeIds: [1],
  franchiseMasterId: null,
  ...o,
});
const faOf20 = (o: Partial<BpAdminTarget> = {}) =>
  target({ roleTypeCode: 'FA', storeIds: [6, 7], franchiseMasterId: 20, ...o });

describe('sideOf', () => {
  it.each([
    ['PM', true, 'HQ'],
    ['PA', true, 'HQ'],
    ['BM', false, 'HQ'],
    ['BA', false, 'HQ'],
    ['FM', false, 'FM'],
    ['FA', false, 'FA'],
  ])('%s (플랫폼 BP %s) → %s', (role, isPlatform, side) => {
    expect(sideOf(role, isPlatform)).toBe(side);
  });

  it('고객 BP 에 붙은 PM · 플랫폼 BP 에 붙은 BM 은 어느 쪽도 아니다', () => {
    expect(sideOf('PM', false)).toBeNull();
    expect(sideOf('BM', true)).toBeNull();
  });
});

describe('canSee', () => {
  it('본사는 세 역할 계정을 모두 본다 — 일부 점포 담당이어도 점포로 좁히지 않는다', () => {
    expect(canSee(hqPart, target({ storeIds: [7] }))).toBe(true);
    expect(canSee(hqPart, target({ roleTypeCode: 'FM', storeIds: [5] }))).toBe(
      true,
    );
    expect(canSee(hqPart, faOf20())).toBe(true);
  });

  it('가맹 쪽은 매핑 점포가 하나라도 겹치는 가맹 관리자만 본다', () => {
    expect(canSee(fm, faOf20())).toBe(true);
    expect(canSee(fa, faOf20({ adminAccountId: 31 }))).toBe(true);
    expect(canSee(fa, faOf20({ adminAccountId: 31, storeIds: [7] }))).toBe(
      false,
    );
  });

  it('연결 가맹 마스터는 자기 가맹 관리자를 점포와 관계없이 본다 — 점포 축소 연쇄로 0곳이 돼도 고칠 사람이 있어야 한다', () => {
    expect(canSee(fm, faOf20({ storeIds: [] }))).toBe(true);
    expect(canSee(fm, faOf20({ storeIds: [1] }))).toBe(true);
    // 다른 가맹 마스터의 가맹 관리자, 같은 가맹 마스터 아래 다른 가맹 관리자는 여전히 점포가 겹쳐야 한다
    expect(canSee(fm, faOf20({ franchiseMasterId: 21, storeIds: [] }))).toBe(
      false,
    );
    expect(canSee(fa, faOf20({ adminAccountId: 31, storeIds: [] }))).toBe(
      false,
    );
  });

  it('가맹 쪽에게 BP 관리자 · 다른 가맹 마스터는 보이지 않는다', () => {
    expect(canSee(fm, target({ storeIds: [5] }))).toBe(false);
    expect(canSee(fm, target({ roleTypeCode: 'FM', adminAccountId: 21 }))).toBe(
      false,
    );
  });

  it('가맹 마스터 · 가맹 관리자는 본인 계정을 본다', () => {
    expect(canSee(fm, target({ roleTypeCode: 'FM', adminAccountId: 20 }))).toBe(
      true,
    );
    expect(canSee(fa, faOf20({ adminAccountId: 30, storeIds: [] }))).toBe(true);
  });
});

describe('creatableRoles', () => {
  it('본사는 BP 관리자 · 가맹 마스터, 가맹 마스터는 가맹 관리자만, 가맹 관리자는 없다', () => {
    expect(creatableRoles(hqPart)).toEqual(['BA', 'FM']);
    expect(creatableRoles(fm)).toEqual(['FA']);
    expect(creatableRoles(fa)).toEqual([]);
  });
});

describe('actionsOf', () => {
  it('본사는 BP 관리자 · 가맹 마스터를 고치고 초기화한다', () => {
    expect(actionsOf(hqAll, target())).toEqual({
      isSelf: false,
      canUpdate: true,
      canResetPassword: true,
      canChangeScope: true,
      canChangeRoleGroup: true,
    });
    expect(actionsOf(hqAll, target({ roleTypeCode: 'FM' }))).toEqual(
      expect.objectContaining({
        canUpdate: true,
        canResetPassword: true,
        // 가맹 마스터는 늘 일부 점포 · 고정 권한이다
        canChangeScope: false,
        canChangeRoleGroup: false,
      }),
    );
  });

  it('일부 점포 담당은 범위(전체 · 일부)를 바꾸지 못한다', () => {
    expect(actionsOf(hqPart, target()).canChangeScope).toBe(false);
    expect(
      actionsOf(hqPart, target({ isAllStores: true, storeIds: [] }))
        .canChangeScope,
    ).toBe(false);
  });

  it('가맹 관리자는 연결된 가맹 마스터만 고친다 — 본사도 조회만', () => {
    expect(actionsOf(fm, faOf20()).canUpdate).toBe(true);
    expect(actionsOf(fm, faOf20()).canResetPassword).toBe(true);
    expect(actionsOf(hqAll, faOf20()).canUpdate).toBe(false);
    expect(actionsOf(hqAll, faOf20()).canResetPassword).toBe(false);
    expect(actionsOf({ ...fm, adminAccountId: 21 }, faOf20()).canUpdate).toBe(
      false,
    );
  });

  it('가맹 관리자는 아무것도 고치지 못한다', () => {
    expect(actionsOf(fa, faOf20({ adminAccountId: 31 })).canUpdate).toBe(false);
  });

  it('본인 계정은 기본정보만 — 초기화 · 범위 · 권한 그룹은 막는다. 가맹 관리자 본인은 조회만', () => {
    const self = actionsOf(hqPart, target({ adminAccountId: 2 }));
    expect(self).toEqual({
      isSelf: true,
      canUpdate: true,
      canResetPassword: false,
      canChangeScope: false,
      canChangeRoleGroup: false,
    });
    expect(
      actionsOf(fm, target({ roleTypeCode: 'FM', adminAccountId: 20 }))
        .canUpdate,
    ).toBe(true);
    expect(actionsOf(fa, faOf20({ adminAccountId: 30 })).canUpdate).toBe(false);
  });
});

describe('assertSelfEdit', () => {
  const none = {
    roleGroupChanged: false,
    statusChanged: false,
    storesChanged: false,
  };

  it('본인이 아니면 그대로 둔다', () => {
    expect(() =>
      assertSelfEdit(false, { ...none, statusChanged: true }),
    ).not.toThrow();
  });

  it.each(['roleGroupChanged', 'statusChanged', 'storesChanged'])(
    '본인 계정의 %s 는 403',
    (key) => {
      expect(() => assertSelfEdit(true, { ...none, [key]: true })).toThrow(
        ForbiddenException,
      );
    },
  );

  it('본인 계정이라도 기본정보만 바꾸면 통과', () => {
    expect(() => assertSelfEdit(true, none)).not.toThrow();
  });
});

describe('planStores', () => {
  const open = new Set<number>();
  const plan = (o: Partial<Parameters<typeof planStores>[0]>) =>
    planStores({
      caller: hqAll,
      role: 'BA',
      requested: { isAllStores: false, storeIds: [1] },
      allowed: new Set(hqAll.storeIds),
      closed: open,
      ...o,
    });

  it('일부 점포는 고른 점포 그대로, 정렬해 돌려준다', () => {
    expect(
      plan({ requested: { isAllStores: false, storeIds: [3, 1] } }),
    ).toEqual({ isAllStores: false, storeIds: [1, 3] });
  });

  it('전체 점포는 매핑을 두지 않는다', () => {
    expect(plan({ requested: { isAllStores: true, storeIds: [1] } })).toEqual({
      isAllStores: true,
      storeIds: [],
    });
  });

  it('전체 점포는 BP 관리자에게만 — 가맹 마스터 · 가맹 관리자는 400', () => {
    for (const role of ['FM', 'FA'] as const)
      expect(() =>
        plan({ role, requested: { isAllStores: true, storeIds: [] } }),
      ).toThrow(BadRequestException);
  });

  it('일부 점포 담당이 전체 점포를 주려 하면 403', () => {
    expect(() =>
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        requested: { isAllStores: true, storeIds: [] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('일부 점포 담당이 전체 점포 계정을 고치면 전체 점포가 그대로 남는다', () => {
    expect(
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        current: { isAllStores: true, storeIds: [] },
        requested: { isAllStores: true, storeIds: [] },
      }),
    ).toEqual({ isAllStores: true, storeIds: [] });
  });

  it('일부 점포 담당이 전체 점포 계정을 일부 점포로 내리려 하면 403', () => {
    expect(() =>
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        current: { isAllStores: true, storeIds: [] },
        requested: { isAllStores: false, storeIds: [1] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('고를 수 있는 점포 밖이면 400', () => {
    expect(() =>
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        requested: { isAllStores: false, storeIds: [1, 3] },
      }),
    ).toThrow('점포 범위를 벗어나 저장하지 않았습니다');
  });

  it('일부 점포인데 한 곳도 없으면 400', () => {
    expect(() =>
      plan({ requested: { isAllStores: false, storeIds: [] } }),
    ).toThrow(BadRequestException);
  });

  it('범위 밖에 이미 매핑된 점포는 요청에 없어도 남는다', () => {
    // 신촌(1) · 강남(2) 담당이 강남(2) · 방화(5) · 월곡(6) 계정을 고쳐 강남을 빼고 신촌을 더한다
    expect(
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        current: { isAllStores: false, storeIds: [2, 5, 6] },
        requested: { isAllStores: false, storeIds: [1] },
      }),
    ).toEqual({ isAllStores: false, storeIds: [1, 5, 6] });
  });

  it('범위 밖 매핑만 남으면 요청이 비어도 저장된다', () => {
    expect(
      plan({
        caller: hqPart,
        allowed: new Set(hqPart.storeIds),
        current: { isAllStores: false, storeIds: [2, 5] },
        requested: { isAllStores: false, storeIds: [] },
      }),
    ).toEqual({ isAllStores: false, storeIds: [5] });
  });

  it('폐점 점포를 새로 붙이면 400', () => {
    expect(() =>
      plan({
        requested: { isAllStores: false, storeIds: [1, 4] },
        closed: new Set([4]),
      }),
    ).toThrow('폐점한 점포는 새로 맡길 수 없습니다');
  });

  it('이미 붙어 있던 폐점 점포는 그대로 남길 수 있다', () => {
    expect(
      plan({
        current: { isAllStores: false, storeIds: [1, 4] },
        requested: { isAllStores: false, storeIds: [1, 4] },
        closed: new Set([4]),
      }),
    ).toEqual({ isAllStores: false, storeIds: [1, 4] });
  });
});

describe('shrinkCascade', () => {
  it('뺀 점포가 매핑된 가맹 관리자만, 그 점포를 뺀 목록으로', () => {
    expect(
      shrinkCascade(
        [6, 7],
        [
          { adminAccountId: 30, storeIds: [5, 6] },
          { adminAccountId: 31, storeIds: [8] },
          { adminAccountId: 32, storeIds: [6, 7] },
        ],
      ),
    ).toEqual([
      { adminAccountId: 30, before: [5, 6], after: [5] },
      // 0곳이 되어도 그대로 돌려준다 — 계정 상태는 바꾸지 않는다(2026-10-23)
      { adminAccountId: 32, before: [6, 7], after: [] },
    ]);
  });

  it('뺀 점포가 없으면 아무도 없다', () => {
    expect(shrinkCascade([], [{ adminAccountId: 30, storeIds: [5] }])).toEqual(
      [],
    );
  });
});
