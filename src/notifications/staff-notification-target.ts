import { workDateOf } from '../work-schedules/work-schedule-rules';

/** 직원 알림함 보관 기간(NOTI-3, 2026-09-17 재영) — 만든 지 14일이 지난 알림은 목록 · 읽음에서 빠진다 */
export const RETENTION_DAYS = 14;

/** 보관 기간의 시작 순간 — 이보다 먼저 만든 알림은 보이지 않는다 */
export const retentionStart = (now: Date) =>
  new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

/**
 * 알림을 눌러 열 곳. 화면 경로가 아니라 무엇을 열지다 — 경로는 직원 근무 앱이 정한다. staffMemberId 는 그 업무가 속한 내
 * 소속이라 앱이 현재 근무지를 그 소속으로 맞춘 뒤 연다. 급여명세서는 근무지와 상관없이 보여(PAY-8) 소속이 없다.
 */
export type StaffNotificationTarget =
  | { type: 'WORK_SCHEDULE'; staffMemberId: number; workDate: string }
  | { type: 'TODO'; staffMemberId: number; todoId: number }
  | { type: 'CONTRACT'; staffMemberId: number; contractId: number }
  | { type: 'PAYSLIP'; payslipId: number };

export type TargetContext = {
  /** 내 재직 소속(ACTIVE_STAFF)의 직원 레코드 */
  myStaffMemberIds: Set<number>;
  /** 점포 → 그 점포의 내 재직 소속 */
  myStaffMemberOfStore: Map<number, number>;
  /** 알림이 가리키는 근무스케줄 — 지운 것도 넣는다(삭제 알림도 그 날짜의 달력으로 간다) */
  schedules: Map<number, { staffMemberId: number; startAt: Date }>;
  /** 알림이 가리키는 TO-DO — 지운 것은 넣지 않는다 */
  todos: Map<number, { storeId: number }>;
  /** 알림이 가리키는 계약 중 내 계약(서명 대기 이후, my-contract-scope) — 직원 앱이 열 수 있는 것만 */
  contracts: Map<number, { staffMemberId: number }>;
  /** 알림이 가리키는 명세서 중 내가 볼 수 있는 것(발송된 것 · 3년 안, my-payslips) — 퇴직해도 본다 */
  payslips: Set<number>;
};

/** 관련 업무로 갈 곳을 정한다. 관련 행이 없거나 내 재직 소속으로 닿을 수 없으면 null — 앱이 「열 수 없습니다」를 보인다 */
export function targetOf(
  row: { relatedType: string | null; relatedId: number | null },
  ctx: TargetContext,
): StaffNotificationTarget | null {
  if (row.relatedId === null) return null;
  if (row.relatedType === 'WORK_SCHEDULE') {
    const schedule = ctx.schedules.get(row.relatedId);
    if (!schedule || !ctx.myStaffMemberIds.has(schedule.staffMemberId))
      return null;
    return {
      type: 'WORK_SCHEDULE',
      staffMemberId: schedule.staffMemberId,
      workDate: workDateOf(schedule.startAt).toISOString().slice(0, 10),
    };
  }
  if (row.relatedType === 'TODO') {
    const todo = ctx.todos.get(row.relatedId);
    const staffMemberId = todo && ctx.myStaffMemberOfStore.get(todo.storeId);
    if (!staffMemberId) return null;
    return { type: 'TODO', staffMemberId, todoId: row.relatedId };
  }
  if (row.relatedType === 'CONTRACT') {
    const contract = ctx.contracts.get(row.relatedId);
    if (!contract) return null;
    return {
      type: 'CONTRACT',
      staffMemberId: contract.staffMemberId,
      contractId: row.relatedId,
    };
  }
  if (row.relatedType === 'PAYSLIP')
    return ctx.payslips.has(row.relatedId)
      ? { type: 'PAYSLIP', payslipId: row.relatedId }
      : null;
  return null;
}
