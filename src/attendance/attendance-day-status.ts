import type {
  AttendanceEntryMethod,
  AttendanceReviewReason,
} from '@prisma/client';

/**
 * 관리자 웹 일별 출퇴근의 상태(API 전용 enum, STAFF-31 의 「출퇴근 상태」 필터 여섯). DB 칸이 아니라 그날의 근무스케줄과
 * 출퇴근 기록에서 만든다. 이 순서가 화면 필터 순서다.
 */
export const ATTENDANCE_DAY_STATUS_LABELS = {
  NORMAL: '정상',
  LATE: '지각',
  ABSENT: '미출근',
  MISSING_CHECK_IN: '출근 미등록',
  MISSING_CHECK_OUT: '퇴근 미등록',
  OFF: '휴무',
} as const;

export type AttendanceDayStatus = keyof typeof ATTENDANCE_DAY_STATUS_LABELS;

export interface DayPunch {
  attendanceRecordId: number;
  recordedAt: Date;
  reviewReason: AttendanceReviewReason | null;
  entryMethod: AttendanceEntryMethod;
}

/** 그날 출근 하나와 그 짝 퇴근(없으면 null). 출근 없는 퇴근(관리자 대신 등록 등)은 checkIn 이 null 이다 */
export interface DayPair {
  checkIn: DayPunch | null;
  checkOut: DayPunch | null;
}

/**
 * 그날 한 직원의 상태. 정책 문서에 판정 기준이 없어(유예 시간 등) 가장 단순하게 정했다(2026-10-23 효준, 확인 필요):
 * - 근무스케줄도 기록도 없으면 휴무.
 * - 출근 없는 퇴근이 있으면 출근 미등록, 퇴근을 더 기다리지 않는 날(`checkOutDue`)에 퇴근 없는 출근이 있으면 퇴근 미등록 —
 *   둘 다 보정이 필요한 쪽을 먼저.
 * - 첫 출근이 첫 근무스케줄 시작보다 늦으면(1분이라도) 지각, 아니면 정상. 근무스케줄 없는 날의 출근은 정상.
 * - 기록 없이 근무스케줄만 있으면, 시작 시각이 지났을 때 미출근 · 아직이면 null(예정).
 * 아직 퇴근을 기다리는 날의 퇴근 없는 출근은 「근무 중」이라 상태를 바꾸지 않는다.
 */
export function attendanceDayStatus(
  scheduleStarts: readonly Date[],
  pairs: readonly DayPair[],
  /** 퇴근을 더 기다리지 않는 날인가(`checkOutDue`) */
  isPastDay: boolean,
  now: Date,
): AttendanceDayStatus | null {
  if (pairs.length === 0) {
    if (scheduleStarts.length === 0) return 'OFF';
    const first = Math.min(...scheduleStarts.map((d) => d.getTime()));
    return now.getTime() > first ? 'ABSENT' : null;
  }
  if (pairs.some((p) => p.checkIn === null)) return 'MISSING_CHECK_IN';
  if (isPastDay && pairs.some((p) => p.checkOut === null))
    return 'MISSING_CHECK_OUT';
  if (scheduleStarts.length === 0) return 'NORMAL';
  const firstStart = Math.min(...scheduleStarts.map((d) => d.getTime()));
  const firstIn = Math.min(
    ...pairs.map((p) => p.checkIn!.recordedAt.getTime()),
  );
  // 분 단위로 본다 — 09:00:30 출근을 09:00 예정에 지각으로 세지 않는다
  return Math.floor(firstIn / 60_000) > Math.floor(firstStart / 60_000)
    ? 'LATE'
    : 'NORMAL';
}

/**
 * 그날 출근의 퇴근을 더 기다리지 않는가. 퇴근은 출근한 다음 날까지 받으므로(밤샘 근무 — 다음 날 퇴근은 출근한 날에 붙는다)
 * 어제 출근은 아직 근무 중일 수 있다. 어제는 근무스케줄이 모두 자정 전에 끝났을 때만 기다리지 않는다 — 근무스케줄이 없거나
 * 자정을 넘기는 날은 오늘이 끝날 때까지 기다린다. 그 전 날은 모두 기다리지 않는다.
 * 날짜는 한국 날짜 `YYYY-MM-DD`, `todayStart` 는 오늘(한국) 0시.
 */
export function checkOutDue(
  date: string,
  scheduleEnds: readonly Date[],
  today: string,
  yesterday: string,
  todayStart: Date,
): boolean {
  if (date >= today) return false;
  if (date < yesterday) return true;
  return (
    scheduleEnds.length > 0 &&
    scheduleEnds.every((end) => end.getTime() <= todayStart.getTime())
  );
}
