import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { retiredBefore } from '../staff-members/retiree-purge';
import { STORAGE, type OptionalStorage } from '../storage/storage.module';
import { deleteWorkSchedules } from '../work-schedules/work-schedule-purge';

/**
 * 한 번에 보는 최대 직원 레코드 수. 다른 파기(5000)보다 작다 — 레코드마다 저장소의 계약서 파일을 트랜잭션 안에서 지워
 * runExclusive 의 60초 제한에 걸리지 않게 한다. 밀린 분량은 다음 날 이어서 지운다.
 */
export const CONTRACT_PURGE_BATCH_SIZE = 100;

/** 근로계약 운영 알림의 related_type(ContractNoticeService · 발송) — 알림톡 발송 기록의 'contract'(소문자)와 다르다 */
const NOTIFICATION_RELATED_TYPE = 'CONTRACT';

@Injectable()
export class ContractPurgeService {
  private readonly logger = new Logger(ContractPurgeService.name);

  constructor(@Inject(STORAGE) private readonly storage: OptionalStorage) {}

  /**
   * 퇴직일로부터 3년이 지난 직원 레코드의 근로계약을 지운다(RET-01, WHALEERP-645). 퇴직 확정(RETIRED) 레코드만 본다 — 퇴직
   * 예정 · 재직 레코드의 계약은 남는다. 계정이 탈퇴해도 같은 기준이다(RET-07). 기준 날짜는 신고 정보 파기와 같다(retiredBefore).
   * 지운 계약 건수를 돌려준다(배치 로그). 레코드 단위로 지운다 — 재계약 줄이 반쯤 끊기지 않게.
   *
   * - 급여명세서(payslips.contract_id, NOT NULL · RESTRICT — 다른 영역)가 가리키는 계약이 하나라도 있는 레코드는 통째로
   *   건너뛴다. 명세서는 생성일 + 3년 파기라, 그 뒤 날마다 다시 보다가 지운다. 건너뛴 레코드 수를 로그로 남긴다(2026-11-03
   *   김민식 확정). 대상을 고를 때부터 빼서 늘 남는 레코드가 한 번에 보는 수를 채우지 않게 한다.
   * - 직원 행(퇴직 취소 · 계약 쓰기와 같은 FOR NO KEY UPDATE) → 계약 행(FOR UPDATE) 순으로 잠근 뒤 명세서를 다시 본다 — 잠그기
   *   전에 만든 명세서를 놓쳐 계약 삭제가 23503 으로 배치째 실패하지 않게.
   * - 저장소의 계약서 파일을 행보다 먼저 지운다. 지우다 실패하면 그 레코드와 남은 레코드는 다음 날로 미룬다 — 저장소가 멈췄으면
   *   레코드마다 기한(25초)을 기다리다 60초를 넘기기 때문이다. 이미 지운 파일은 다음 날 다시 지워도 S3 가 성공으로 본다.
   *
   * 계약을 가리키는 행(2026-11-03 김민식 확정): 그 계약으로 만든 근무스케줄(work_schedules.source_contract_id)은 생성일 + 3년
   * 파기 기한도 지났으니 변경 이력 · 관련 알림과 함께 지운다. 근로계약 운영 알림은 받는 사람 · 발송까지 지운다. 퇴직 처리
   * 이력(contract_id)과 다른 레코드 계약의 직전 계약(previous_contract_id)은 연결만 비운다. 알림톡 발송 기록(alimtalk_send_logs,
   * 외래키 없음)은 그대로 둔다.
   */
  async purgeRetiredContracts(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<number> {
    const before = retiredBefore(now);
    const [{ skipped }] = await tx.$queryRaw<{ skipped: number }[]>`
      SELECT count(*)::int AS skipped FROM staff_members s
      WHERE s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
        AND EXISTS (SELECT 1 FROM contracts c JOIN payslips p ON p.contract_id = c.contract_id
          WHERE c.staff_member_id = s.staff_member_id)
    `;
    if (skipped > 0)
      this.logger.log(`contract purge SKIPPED_PAYSLIP staff=${skipped}`);
    const staff = await tx.$queryRaw<{ id: number }[]>`
      SELECT s.staff_member_id AS id FROM staff_members s
      WHERE s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
        AND EXISTS (SELECT 1 FROM contracts c WHERE c.staff_member_id = s.staff_member_id)
        AND NOT EXISTS (SELECT 1 FROM contracts c JOIN payslips p ON p.contract_id = c.contract_id
          WHERE c.staff_member_id = s.staff_member_id)
      ORDER BY s.retired_date, s.staff_member_id
      LIMIT ${CONTRACT_PURGE_BATCH_SIZE}
      FOR NO KEY UPDATE OF s
    `;
    if (staff.length === 0) return 0;
    const locked = await tx.$queryRaw<{ id: number; staffMemberId: number }[]>`
      SELECT contract_id AS id, staff_member_id AS "staffMemberId" FROM contracts
      WHERE staff_member_id = ANY(${staff.map((s) => s.id)}::int[])
      ORDER BY contract_id
      FOR UPDATE
    `;
    const blocked = new Set(
      (
        await tx.payslip.findMany({
          where: { contractId: { in: locked.map((c) => c.id) } },
          select: { contract: { select: { staffMemberId: true } } },
        })
      ).map((p) => p.contract.staffMemberId),
    );
    const purgeable = staff.map((s) => s.id).filter((id) => !blocked.has(id));
    const done = await this.deleteFiles(tx, purgeable);
    const ids = locked
      .filter((c) => done.includes(c.staffMemberId))
      .map((c) => c.id);
    if (ids.length === 0) return 0;

    const schedules = await tx.$queryRaw<{ id: number }[]>`
      SELECT work_schedule_id AS id FROM work_schedules
      WHERE source_contract_id = ANY(${ids}::int[])
      FOR UPDATE
    `;
    await deleteWorkSchedules(
      tx,
      schedules.map((s) => s.id),
    );
    const notification = {
      relatedType: NOTIFICATION_RELATED_TYPE,
      relatedId: { in: ids },
    };
    await tx.notificationDelivery.deleteMany({
      where: { notificationRecipient: { notification } },
    });
    await tx.notificationRecipient.deleteMany({ where: { notification } });
    await tx.notification.deleteMany({ where: notification });
    await tx.staffMemberRetirementLog.updateMany({
      where: { contractId: { in: ids } },
      data: { contractId: null },
    });
    // 같은 레코드의 재계약끼리도 — RESTRICT 는 행마다 바로 보므로 함께 지우는 앞 계약도 먼저 비운다
    await tx.contract.updateMany({
      where: { previousContractId: { in: ids } },
      data: { previousContractId: null },
    });
    const byContract = { where: { contractId: { in: ids } } };
    await tx.contractDocument.deleteMany(byContract);
    await tx.contractStatusHistory.deleteMany(byContract);
    await tx.contractParty.deleteMany(byContract);
    await tx.contractWorkDay.deleteMany(byContract);
    const { count } = await tx.contract.deleteMany(byContract);
    return count;
  }

  /** 레코드 순서대로 계약서 파일을 지우고, 다 지운 레코드를 돌려준다. 처음 실패한 레코드부터는 다음 날로 미룬다. */
  private async deleteFiles(
    tx: Prisma.TransactionClient,
    staffMemberIds: number[],
  ): Promise<number[]> {
    const documents = await tx.contractDocument.findMany({
      where: { contract: { staffMemberId: { in: staffMemberIds } } },
      select: {
        storageKey: true,
        contract: { select: { staffMemberId: true } },
      },
    });
    const done: number[] = [];
    for (const staffMemberId of staffMemberIds) {
      const keys = documents
        .filter((d) => d.contract.staffMemberId === staffMemberId)
        .map((d) => d.storageKey);
      if (keys.length > 0) {
        if (!this.storage) {
          this.logger.error(
            `contract purge FILES_DEFERRED staff=${staffMemberId}: 저장소 설정이 없다`,
          );
          break;
        }
        const storage = this.storage;
        try {
          // 계약서 파일은 썸네일이 없다(날인본 정리와 같다)
          await Promise.all(
            keys.map((key) => storage.delete(key, { thumbnail: false })),
          );
        } catch (e) {
          this.logger.error(
            `contract purge FILES_DEFERRED staff=${staffMemberId}: ${String(e)}`,
          );
          break;
        }
      }
      done.push(staffMemberId);
    }
    return done;
  }
}

@Injectable()
export class ContractPurgeScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly purge: ContractPurgeService,
  ) {}

  // 04:40 일괄 저장 파일 정리 뒤, 신고 정보(05:10) · 계정 변경 이력(05:20) 파기 앞이다. 건수는 runExclusive 가
  // `contract-purge RAN processed=N` 으로 남긴다.
  @Cron('0 0 5 * * *', {
    name: BATCH_JOB.CONTRACT_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async run(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.CONTRACT_PURGE, (tx) =>
      this.purge.purgeRetiredContracts(tx),
    );
  }
}
