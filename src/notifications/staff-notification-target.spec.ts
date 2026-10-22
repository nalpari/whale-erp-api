import {
  RETENTION_DAYS,
  retentionStart,
  targetOf,
  type TargetContext,
} from './staff-notification-target';

const ctx: TargetContext = {
  // 내 재직 소속 — 직원 레코드 7(점포 10), 9(점포 20)
  myStaffMemberIds: new Set([7, 9]),
  myStaffMemberOfStore: new Map([
    [10, 7],
    [20, 9],
  ]),
  schedules: new Map([
    [100, { staffMemberId: 7, startAt: new Date('2026-10-21T15:30:00Z') }],
    [101, { staffMemberId: 3, startAt: new Date('2026-10-22T00:00:00Z') }],
  ]),
  todos: new Map([
    [200, { storeId: 20 }],
    [201, { storeId: 30 }],
  ]),
};

describe('staff-notification-target', () => {
  it('근무스케줄 — 내 재직 소속이면 그 소속과 근무일(시작 일시의 한국 날짜)', () => {
    expect(
      targetOf({ relatedType: 'WORK_SCHEDULE', relatedId: 100 }, ctx),
    ).toEqual({
      type: 'WORK_SCHEDULE',
      staffMemberId: 7,
      workDate: '2026-10-22',
    });
  });

  it('근무스케줄 — 행이 없거나(파기) 내 재직 소속이 아니면(퇴직 · 남의 것) null', () => {
    expect(
      targetOf({ relatedType: 'WORK_SCHEDULE', relatedId: 999 }, ctx),
    ).toBeNull();
    expect(
      targetOf({ relatedType: 'WORK_SCHEDULE', relatedId: 101 }, ctx),
    ).toBeNull();
  });

  it('TO-DO — 그 점포의 내 재직 소속, 지웠거나 내 소속이 없는 점포면 null', () => {
    expect(targetOf({ relatedType: 'TODO', relatedId: 200 }, ctx)).toEqual({
      type: 'TODO',
      staffMemberId: 9,
      todoId: 200,
    });
    expect(targetOf({ relatedType: 'TODO', relatedId: 999 }, ctx)).toBeNull();
    expect(targetOf({ relatedType: 'TODO', relatedId: 201 }, ctx)).toBeNull();
  });

  it('그 밖의 관련 업무 · 관련 업무 없음은 null', () => {
    expect(targetOf({ relatedType: 'CONTRACT', relatedId: 1 }, ctx)).toBeNull();
    expect(targetOf({ relatedType: null, relatedId: null }, ctx)).toBeNull();
  });

  it('보관은 14일 — 지금부터 14일 전 순간까지', () => {
    expect(RETENTION_DAYS).toBe(14);
    expect(retentionStart(new Date('2026-10-22T06:00:00Z'))).toEqual(
      new Date('2026-10-08T06:00:00Z'),
    );
  });
});
