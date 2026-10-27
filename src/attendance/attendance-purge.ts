import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { addMonths, kstDayStart, kstToday } from '../staff-members/kst-date';

/** 보존 기간 — 생성일로부터 3년(WHALEERP-209) */
const RETENTION_MONTHS = 36;

/** 한 번에 지우는 최대 건수 — 근무스케줄 파기와 같은 까닭(runExclusive 60초 제한, api #112 리뷰) */
export const PURGE_BATCH_SIZE = 5000;

/**
 * 생성일로부터 3년이 지난 출퇴근 기록을 지운다(WHALEERP-209). 생성일은 서버 수신 시각(received_at)이다 — 기록 시각은 대신
 * 등록이면 지난 시각일 수 있다. 근무스케줄 파기와 같이 한국 날짜로 세고, 생성일 당일부터 3년째 되는 날까지 남는다.
 * 지운 기록 건수를 돌려준다(배치 로그).
 *
 * 대상을 FOR UPDATE 로 잠근 뒤, 대상을 가리키는 것을 먼저 푼다(외래키가 모두 RESTRICT 라 걸리면 배치째 실패한다).
 * - 짝 출근(check_in_attendance_record_id): 밤샘 근무의 퇴근은 출근보다 하루 늦게 기한이 차서 그날은 남는다. 그 퇴근에서
 *   짝을 비운다 — 같은 문장에서 함께 지우는 짝도 RESTRICT 는 행마다 바로 보므로 대상끼리도 먼저 비운다.
 * - 위치정보 확인자료(location_access_logs): 계정 · BP 탈퇴까지 남는다(RET-08) — 기록 연결만 비우고 확인자료는 둔다.
 * - 보정 이력은 기록과 함께 지운다.
 */
export async function purgeExpiredAttendanceRecords(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = kstDayStart(addMonths(kstToday(now), -RETENTION_MONTHS));
  const targets = await tx.$queryRaw<{ id: number }[]>`
    SELECT attendance_record_id AS id FROM attendance_records
    WHERE received_at < ${cutoff}
    ORDER BY received_at, attendance_record_id
    LIMIT ${PURGE_BATCH_SIZE}
    FOR UPDATE
  `;
  if (targets.length === 0) return 0;
  const ids = targets.map((t) => t.id);
  await tx.attendanceRecord.updateMany({
    where: { checkInAttendanceRecordId: { in: ids } },
    data: { checkInAttendanceRecordId: null },
  });
  await tx.locationAccessLog.updateMany({
    where: { attendanceRecordId: { in: ids } },
    data: { attendanceRecordId: null },
  });
  await tx.attendanceCorrection.deleteMany({
    where: { attendanceRecordId: { in: ids } },
  });
  const { count } = await tx.attendanceRecord.deleteMany({
    where: { attendanceRecordId: { in: ids } },
  });
  return count;
}

@Injectable()
export class AttendancePurgeScheduler {
  constructor(private readonly lock: BatchLockService) {}

  // 03:00 근무스케줄 파기 뒤에 돈다. 건수는 runExclusive 가 `attendance-purge RAN processed=N` 으로 남긴다.
  @Cron('0 30 3 * * *', {
    name: BATCH_JOB.ATTENDANCE_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.ATTENDANCE_PURGE, (tx) =>
      purgeExpiredAttendanceRecords(tx),
    );
  }
}
