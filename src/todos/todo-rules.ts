import type { Prisma, TodoStatus } from '@prisma/client';

// 수행 예정 날짜(@db.Date)는 UTC 자정, 시간(@db.Time)은 1970-01-01 의 그 시각으로 온다(kst-date.ts). 둘 다 한국 시각이다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * TO-DO 의 「재직 직원」 — 배정 검증 · 근무지 전체 펼치기 · 수행 임박 알림 수신자 · 직원 근무 앱 내 TO-DO · 등록의 직원
 * 고르기가 모두 이것을 쓴다(운영 정책 PAY-16 · CTR-29, 2026-10-19 재영). 그 점포에 체결 완료 근로계약이 있고, 가입을
 * 마쳤고(계정 있음), 퇴직하지 않은 직원 레코드다. 퇴직 예정(퇴직일까지 재직)은 넣는다. 종이 계약은 가입 전에도 체결
 * 완료라 가입 완료를 따로 본다 — 앱을 열 수 없는 직원에게 TO-DO 를 주지 않는다(2026-10-19 재영). 계약 종료일이 지났어도
 * 상태가 체결 완료면 넣는다 — 기간 만료로 상태를 바꾸는 규칙이 없다. 직원 레코드는 점포마다 따로라 그 레코드의 계약이
 * 곧 그 점포의 계약이다.
 */
export const ACTIVE_STAFF = {
  employmentStatus: 'EMPLOYED',
  joinStatus: 'JOINED',
  contracts: { some: { status: 'SIGNED' } },
} as const satisfies Prisma.StaffMemberWhereInput;

type Sortable = {
  todoId: number;
  status: TodoStatus;
  isUrgent: boolean;
  dueDate: Date;
  dueTime: Date | null;
};

/** 정렬 묶음 — 미완료 긴급 0 · 미완료 나머지 1 · 완료 2 */
const bucket = (t: Sortable) => (t.status === 'DONE' ? 2 : t.isUrgent ? 0 : 1);

/**
 * TO-DO 목록 정렬. 미완료 긴급 → 미완료 나머지 → 완료, 묶음 안은 수행 예정 일시 오름차순(날짜만인 것은 그날의 시간
 * 있는 것 뒤), 마지막은 ID 다. 묶음을 Prisma orderBy 로 쓸 수 없어(CASE) 읽은 뒤 정렬한다.
 */
export function compareTodos(a: Sortable, b: Sortable): number {
  return (
    bucket(a) - bucket(b) ||
    a.dueDate.getTime() - b.dueDate.getTime() ||
    (a.dueTime?.getTime() ?? Infinity) - (b.dueTime?.getTime() ?? Infinity) ||
    a.todoId - b.todoId
  );
}

/** 배정 그룹 한 줄의 상태. 모두 완료면 완료, 모두 대기면 대기, 그 밖은 진행 중이다. */
export function groupStatus(statuses: TodoStatus[]): TodoStatus {
  if (statuses.every((s) => s === 'DONE')) return 'DONE';
  if (statuses.every((s) => s === 'PENDING')) return 'PENDING';
  return 'IN_PROGRESS';
}

/** 수행 임박 알림을 보낼 때. 시간이 있으면 수행 예정 일시 1시간 전, 날짜만이면 그날 한국 09:00(= UTC 0시). */
export function dueReminderAt(dueDate: Date, dueTime: Date | null): Date {
  if (!dueTime) return dueDate;
  return new Date(
    dueDate.getTime() + dueTime.getTime() - KST_OFFSET_MS - HOUR_MS,
  );
}

/** 수행 예정 일시가 지나는 때. 날짜만이면 그날이 끝날 때(다음 날 한국 0시). */
export function dueEndsAt(dueDate: Date, dueTime: Date | null): Date {
  return new Date(
    dueTime
      ? dueDate.getTime() + dueTime.getTime() - KST_OFFSET_MS
      : dueDate.getTime() + 24 * HOUR_MS - KST_OFFSET_MS,
  );
}

const hhmm = (time: Date) => time.toISOString().slice(11, 16);

/** dedupe_key 에 넣는 수행 예정 일시 — `2026-10-19T18:00` · 날짜만이면 `2026-10-19` (T-3) */
export function dueKey(dueDate: Date, dueTime: Date | null): string {
  const date = dueDate.toISOString().slice(0, 10);
  return dueTime ? `${date}T${hhmm(dueTime)}` : date;
}

/** 알림 문구의 수행 예정 일시 — `10월 8일 18:00` · 날짜만이면 `10월 8일` */
export function dueLabel(dueDate: Date, dueTime: Date | null): string {
  const date = `${dueDate.getUTCMonth() + 1}월 ${dueDate.getUTCDate()}일`;
  return dueTime ? `${date} ${hhmm(dueTime)}` : date;
}
