import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { addMonths, kstDayStart, kstToday } from '../staff-members/kst-date';

/** 보존 기간 — 생성일로부터 3년(운영 정책 RET-02, WHALEERP-649) */
const RETENTION_MONTHS = 36;

/** 한 번에 지우는 최대 명세서 수 — 출퇴근 · 근무스케줄 파기와 같은 까닭(runExclusive 60초 제한, api #112 리뷰) */
export const PAYSLIP_PURGE_BATCH_SIZE = 5000;

/** 급여명세서 알림의 related_type(직원 앱 알림 — 명세서 발송) */
const NOTIFICATION_RELATED_TYPE = 'PAYSLIP';

/**
 * 생성일로부터 3년이 지난 급여명세서를 지운다(RET-02, WHALEERP-649). 생성일은 만든 시각(created_at)이고, 출퇴근 · 근무스케줄
 * 파기와 같이 한국 날짜로 세어 생성일 + 3년 당일까지 남고 다음 날 지운다. 상태 · 재직과 상관없고, 직원 계정이 탈퇴해도 같은
 * 기준이다(RET-07). 지운 명세서 수를 돌려준다(배치 로그).
 *
 * 대상을 FOR UPDATE 로 잠근 뒤 딸린 행을 먼저 지운다(외래키가 모두 RESTRICT 라 걸리면 배치째 실패한다) — 항목 · 검토 사유 ·
 * 발송 기록 · 처리 이력. 그 명세서의 알림(related_type 'PAYSLIP')은 외래키가 없지만 받는 사람 · 발송까지 함께 지운다. 명세서 파일은 저장하지 않는다
 * (PDF 는 내려받을 때 만든다). 명세서가 없어지면 그 계약은 다음 계약 파기(contract-purge, 05:00)부터 지울 수 있다 — 그래서
 * 그보다 먼저 돈다.
 */
export async function purgeExpiredPayslips(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = kstDayStart(addMonths(kstToday(now), -RETENTION_MONTHS));
  const targets = await tx.$queryRaw<{ id: number }[]>`
    SELECT payslip_id AS id FROM payslips
    WHERE created_at < ${cutoff}
    ORDER BY created_at, payslip_id
    LIMIT ${PAYSLIP_PURGE_BATCH_SIZE}
    FOR UPDATE
  `;
  if (targets.length === 0) return 0;
  const ids = targets.map((t) => t.id);
  const owned = { payslipId: { in: ids } };
  await tx.payslipItem.deleteMany({ where: owned });
  await tx.payslipReviewReason.deleteMany({ where: owned });
  await tx.payslipDispatch.deleteMany({ where: owned });
  await tx.payslipLog.deleteMany({ where: owned });
  const notification = {
    relatedType: NOTIFICATION_RELATED_TYPE,
    relatedId: { in: ids },
  };
  await tx.notificationDelivery.deleteMany({
    where: { notificationRecipient: { notification } },
  });
  await tx.notificationRecipient.deleteMany({ where: { notification } });
  await tx.notification.deleteMany({ where: notification });
  const { count } = await tx.payslip.deleteMany({ where: owned });
  return count;
}

@Injectable()
export class PayslipPurgeScheduler {
  constructor(private readonly lock: BatchLockService) {}

  // 05:00 계약 파기 앞에 돈다. 건수는 runExclusive 가 `payslip-purge RAN processed=N` 으로 남긴다.
  @Cron('0 50 4 * * *', {
    name: BATCH_JOB.PAYSLIP_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.PAYSLIP_PURGE, (tx) =>
      purgeExpiredPayslips(tx),
    );
  }
}
