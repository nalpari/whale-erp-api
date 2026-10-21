import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { addMonths, kstDayStart, kstToday } from '../staff-members/kst-date';
import { RELATED_TYPE } from './work-schedule-notice';

/** 보존 기간 — 생성일로부터 3년(운영 정책 RET-02) */
const RETENTION_MONTHS = 36;

/**
 * 생성일로부터 3년이 지난 근무스케줄을 지운다(#609, 2026-10-21 재영 · 운영 정책 RET-02 · 쟁점 STAFF-42). 생성일 당일부터
 * 3년째 되는 날까지 남고 그다음 날 지워진다 — 한국 날짜로 센다(도입문의 파기와 같은 꼴). 삭제 표시(is_deleted)된 것도
 * 같은 기준이다. 그 근무스케줄을 가리키는 저장 알림(related_type = WORK_SCHEDULE — 본문에 근무지 · 근무일 · 시각)도 받는 사람 ·
 * 발송까지 같은 트랜잭션에서 지운다(Q13, 2026-10-21 재영 — 도입문의 파기와 같다). 「직원 알림함 14일」은 화면 표시 기간이고 행은
 * 남기 때문이다. 알림 쪽 외래키가 RESTRICT 라 발송 → 받는 사람 → 알림 순이다. 지운 근무스케줄 건수를 돌려준다(배치 로그).
 * 일괄 등록 · 지난 주 복사의 묶음 알림은 첫 근무스케줄을 가리키므로 그것이 지워질 때 함께 지워진다.
 *
 * 세 문장이다 — 대상을 먼저 FOR UPDATE 로 잠그고, 그 ID 로 변경 이력(외래키 RESTRICT)을, 그다음 근무스케줄을 지운다. 이력
 * 삭제를 잠그기 전 스냅샷으로 돌리면, 그사이 관리자가 그 근무스케줄을 고쳐 커밋한 이력을 놓쳐 근무스케줄 삭제가 23503 으로
 * 배치째 실패한다(api 리뷰). 잠근 뒤의 문장은 새 스냅샷이라 그 이력까지 지운다. 관리자 쪽은 잠금을 기다렸다가 지워진 것을
 * 보고 404 다.
 */
export async function purgeExpiredWorkSchedules(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = kstDayStart(addMonths(kstToday(now), -RETENTION_MONTHS));
  const targets = await tx.$queryRaw<{ id: number }[]>`
    SELECT work_schedule_id AS id FROM work_schedules
    WHERE created_at < ${cutoff}
    ORDER BY work_schedule_id
    FOR UPDATE
  `;
  if (targets.length === 0) return 0;
  const ids = targets.map((t) => t.id);
  const notification = { relatedType: RELATED_TYPE, relatedId: { in: ids } };
  await tx.notificationDelivery.deleteMany({
    where: { notificationRecipient: { notification } },
  });
  await tx.notificationRecipient.deleteMany({ where: { notification } });
  await tx.notification.deleteMany({ where: notification });
  await tx.workScheduleHistory.deleteMany({
    where: { workScheduleId: { in: ids } },
  });
  const { count } = await tx.workSchedule.deleteMany({
    where: { workScheduleId: { in: ids } },
  });
  return count;
}

@Injectable()
export class WorkSchedulePurgeScheduler {
  constructor(private readonly lock: BatchLockService) {}

  // timeZone 을 빼면 서버 타임존에 돈다. 자정에 도는 다른 배치(퇴직 확정 · 도입문의 파기)와 겹치지 않게 03:00 이다.
  // 건수는 runExclusive 가 `work-schedule-purge RAN processed=N` 으로 남긴다.
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: BATCH_JOB.WORK_SCHEDULE_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.WORK_SCHEDULE_PURGE, (tx) =>
      purgeExpiredWorkSchedules(tx),
    );
  }
}
