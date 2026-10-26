import {
  actionsOf,
  callerOf,
  type HolidayCaller,
  type ManagedHoliday,
} from './bp-holiday-access';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = d('2026-10-26');

const RIGHTS = { create: true, update: true, delete: true };
const full: HolidayCaller = {
  adminAccountId: 1,
  bpCodeId: 7,
  manageAll: true,
  storeScope: null,
  rights: RIGHTS,
};
const limited: HolidayCaller = {
  ...full,
  manageAll: false,
  storeScope: new Set([10]),
};

const weekly = (start: string): ManagedHoliday => ({
  isAllStores: false,
  openStoreIds: [10],
  holidayTypeCode: 'REPEAT',
  startDate: d(start),
  endDate: null,
  holidayRepeatTypeCode: 'WEEKLY',
  repeatEndType: 'NONE',
  repeatEndDate: null,
  repeatCount: null,
});

describe('callerOf — 계정에서 휴일을 다루는 범위를 정한다', () => {
  const base = {
    adminAccountId: 1,
    targetBpCodeId: 7,
    isPlatform: false,
    isAllStores: true,
    mappedStoreIds: [10],
    rights: RIGHTS,
  };
  it.each([
    [
      '플랫폼 계정',
      { isPlatform: true, roleTypeCode: 'PA', isAllStores: false },
      true,
      null,
    ],
    ['BP 마스터', { roleTypeCode: 'BM' }, true, null],
    ['전체 점포 BP 관리자', { roleTypeCode: 'BA' }, true, null],
    [
      '일부 점포 BP 관리자',
      { roleTypeCode: 'BA', isAllStores: false },
      false,
      [10],
    ],
    ['가맹 마스터', { roleTypeCode: 'FM', isAllStores: false }, false, [10]],
    // 가맹 역할은 전체 점포여도 전체 점포 휴일 · 예외 점포를 다루지 못한다(CONFIG-10)
    ['전체 점포 가맹 관리자', { roleTypeCode: 'FA' }, false, null],
  ])('%s', (_, over, manageAll, scope) => {
    const caller = callerOf({ ...base, ...over });
    expect(caller.manageAll).toBe(manageAll);
    expect(caller.storeScope && [...caller.storeScope]).toEqual(scope);
  });
});

describe('actionsOf — 이 사용자가 이 휴일에 할 수 있는 것', () => {
  it('진행 중이고 어제 이전에 시작했으면 수정 · 강제 종료, 삭제는 아니다', () => {
    expect(actionsOf(full, weekly('2026-09-21'), today)).toEqual({
      canUpdate: true,
      canUpdateStores: true,
      canTerminate: true,
      canDelete: false,
      blockedReason: null,
    });
  });

  it('오늘 시작한 휴일은 강제 종료 대신 삭제', () => {
    expect(actionsOf(full, weekly('2026-10-26'), today)).toMatchObject({
      canTerminate: false,
      canDelete: true,
      blockedReason:
        '오늘 시작한 휴일은 강제 종료할 수 없습니다 — 삭제해 주세요',
    });
  });

  it('시작 전 휴일은 삭제할 수 있다', () => {
    expect(actionsOf(full, weekly('2026-11-02'), today)).toMatchObject({
      canUpdate: true,
      canTerminate: false,
      canDelete: true,
    });
  });

  it('끝난 휴일은 아무것도 못 하고 사유를 준다', () => {
    const ended = {
      ...weekly('2026-09-21'),
      repeatEndType: 'UNTIL_DATE' as const,
      repeatEndDate: d('2026-10-19'),
    };
    expect(actionsOf(full, ended, today)).toEqual({
      canUpdate: false,
      canUpdateStores: false,
      canTerminate: false,
      canDelete: false,
      blockedReason: '끝난 휴일은 고칠 수 없습니다',
    });
  });

  it('범위 밖 점포가 묶인 휴일은 자기 점포만 고친다', () => {
    const shared = { ...weekly('2026-09-21'), openStoreIds: [10, 20] };
    expect(actionsOf(limited, shared, today)).toEqual({
      canUpdate: false,
      canUpdateStores: true,
      canTerminate: false,
      canDelete: false,
      blockedReason:
        '맡지 않은 점포가 함께 묶인 휴일입니다 — 맡은 점포만 빼거나 더할 수 있습니다',
    });
  });

  it('전체 점포 휴일은 일부 점포 사용자가 조회만 한다', () => {
    const all = {
      ...weekly('2026-09-21'),
      isAllStores: true,
      openStoreIds: [],
    };
    expect(actionsOf(limited, all, today)).toMatchObject({
      canUpdate: false,
      canUpdateStores: false,
      canTerminate: false,
      canDelete: false,
    });
  });

  // 화면이 보여 준 버튼이 가드에서 403 이 되지 않게 — 수정은 update 칸, 강제 종료 · 삭제는 delete 칸만 본다.
  it.each([
    [
      '수정 칸만 꺼짐 · 진행 중',
      { update: false },
      '2026-09-21',
      {
        canUpdate: false,
        canUpdateStores: false,
        canTerminate: true,
        canDelete: false,
      },
    ],
    [
      '삭제 칸만 꺼짐 · 진행 중',
      { delete: false },
      '2026-09-21',
      {
        canUpdate: true,
        canUpdateStores: true,
        canTerminate: false,
        canDelete: false,
      },
    ],
    [
      '수정 칸만 꺼짐 · 시작 전',
      { update: false },
      '2026-11-02',
      {
        canUpdate: false,
        canUpdateStores: false,
        canTerminate: false,
        canDelete: true,
      },
    ],
    [
      '삭제 칸만 꺼짐 · 시작 전',
      { delete: false },
      '2026-11-02',
      {
        canUpdate: true,
        canUpdateStores: true,
        canTerminate: false,
        canDelete: false,
      },
    ],
  ])('%s', (_, off, start, expected) => {
    const caller = { ...full, rights: { ...RIGHTS, ...off } };
    expect(actionsOf(caller, weekly(start), today)).toMatchObject(expected);
  });

  it('메뉴 권한이 없으면 그 동작은 false', () => {
    const readOnly = {
      ...full,
      rights: { create: false, update: false, delete: false },
    };
    expect(actionsOf(readOnly, weekly('2026-09-21'), today)).toMatchObject({
      canUpdate: false,
      canUpdateStores: false,
      canTerminate: false,
    });
  });
});
