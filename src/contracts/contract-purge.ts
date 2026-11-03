import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { retiredBefore } from '../staff-members/retiree-purge';
import { STORAGE, type OptionalStorage } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { deleteWorkSchedules } from '../work-schedules/work-schedule-purge';

/**
 * 한 번에 지우는 최대 직원 레코드 수. 다른 파기(5000)보다 작다 — 레코드마다 저장소의 계약서 파일을 트랜잭션 안에서 지워
 * runExclusive 의 60초 제한에 걸리지 않게 한다. 밀린 분량은 다음 날 이어서 지운다. 미룬 레코드는 세지 않는다.
 */
export const CONTRACT_PURGE_BATCH_SIZE = 100;

/**
 * 파일 삭제 · 대상 더 고르기를 시작하는 시간 상한 — 함수 시작부터 잰다. 넘으면 남은 레코드는 다음 날. 한 레코드의 삭제가 저장소 기한(25초)까지
 * 걸려도 이 상한과 합쳐 runExclusive 의 60초 안에서 행을 지우고 커밋한다 — 파일 뒤의 문장은 알림 행 말고는 이미 잠근 행만
 * 건드린다(알림은 읽음 표시 같은 짧은 쓰기만 겹친다).
 */
export const FILE_DELETE_BUDGET_MS = 25_000;

/** 근로계약 알림의 related_type(관리자 운영 알림 · 직원 앱 알림) — 알림톡 발송 기록의 'contract'(소문자)와 다르다 */
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
   * - 저장소 설정이 없으면 아무것도 하지 않는다(일괄 저장 파일 정리와 같다) — 파일을 못 지워 날마다 같은 레코드를 미루지 않게.
   * - 급여명세서(payslips.contract_id, NOT NULL · RESTRICT — 다른 영역)가 가리키는 계약이 하나라도 있는 레코드는 통째로
   *   건너뛴다. 날마다 다시 보고, 명세서가 없어진 다음 날 지운다. 건너뛴 레코드 수를 로그로 남긴다(2026-11-03 김민식 확정).
   *   대상을 고를 때부터 빼서 늘 남는 레코드가 한 번에 보는 수를 채우지 않게 한다. 명세서 파기(생성일 + 3년, RET-02)는
   *   WHALEERP-323 아래 후속 일감이다 — 그것이 생기기 전까지 명세서를 받은 퇴직자의 계약은 남는다.
   * - 대상은 퇴직일이 이른 순으로 고르되, 직원 행은 id 순으로 잠근다(lockStaffForReplace · 하루 배치와 같은 순서 — 계약 등록과
   *   교착하지 않게, api #238 리뷰). 잠근 뒤 퇴직 · 기준 날짜를 다시 본다.
   * - 파일을 못 지워 미룬 레코드는 이번 실행에서 다시 고르지 않고, 지운 레코드가 한 번에 지우는 수(100)에 찰 때까지 그다음
   *   퇴직자를 더 고른다 — 늘 실패하는 레코드가 쌓여도 뒤 퇴직자가 막히지 않게(api #238 리뷰). 시간 상한이 끝을 정한다.
   * - 직원 행(퇴직 취소 · 계약 쓰기와 같은 FOR NO KEY UPDATE) → 계약 행(FOR UPDATE) 순으로 잠근 뒤 명세서를 다시 본다 — 잠그기
   *   전에 만든 명세서를 놓쳐 계약 삭제가 23503 으로 배치째 실패하지 않게. 계약을 가리키는 근무스케줄 · 퇴직 처리 이력 · 다른
   *   계약도 파일을 지우기 전에 잠근다.
   * - 저장소의 계약서 파일을 행보다 먼저 지운다(deleteFiles). 이미 지운 파일은 다음 날 다시 지워도 S3 가 성공으로 본다.
   *
   * 계약을 가리키는 행(2026-11-03 김민식 확정): 그 계약으로 만든 근무스케줄(work_schedules.source_contract_id)은 생성일 + 3년
   * 파기 기한도 지났으니 변경 이력 · 관련 알림과 함께 지운다. related_type 'CONTRACT' 알림 — 관리자 운영 알림과 직원 앱 알림
   * (근로계약서 발송 등) 모두 — 은 받는 사람 · 발송까지 지운다. 퇴직 처리 이력(contract_id)과 다른 레코드 계약의 직전
   * 계약(previous_contract_id)은 연결만 비운다. 알림톡 발송 기록(alimtalk_send_logs, 외래키 없음)은 그대로 둔다.
   */
  async purgeRetiredContracts(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<number> {
    const started = Date.now();
    const storage = this.storage;
    if (!storage) {
      this.logger.warn('contract purge SKIPPED_NO_STORAGE');
      return 0;
    }
    const before = retiredBefore(now);
    const [{ skipped }] = await tx.$queryRaw<{ skipped: number }[]>`
      SELECT count(*)::int AS skipped FROM staff_members s
      WHERE s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
        AND EXISTS (SELECT 1 FROM contracts c JOIN payslips p ON p.contract_id = c.contract_id
          WHERE c.staff_member_id = s.staff_member_id)
    `;
    if (skipped > 0)
      this.logger.log(`contract purge SKIPPED_PAYSLIP staff=${skipped}`);

    const tried: number[] = [];
    let purged = 0;
    let count = 0;
    while (
      purged < CONTRACT_PURGE_BATCH_SIZE &&
      Date.now() - started <= FILE_DELETE_BUDGET_MS
    ) {
      const picked = await tx.$queryRaw<{ id: number }[]>`
        SELECT s.staff_member_id AS id FROM staff_members s
        WHERE s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
          AND NOT (s.staff_member_id = ANY(${[...tried]}::int[]))
          AND EXISTS (SELECT 1 FROM contracts c WHERE c.staff_member_id = s.staff_member_id)
          AND NOT EXISTS (SELECT 1 FROM contracts c JOIN payslips p ON p.contract_id = c.contract_id
            WHERE c.staff_member_id = s.staff_member_id)
        ORDER BY s.retired_date, s.staff_member_id
        LIMIT ${CONTRACT_PURGE_BATCH_SIZE - purged}
      `;
      if (picked.length === 0) break;
      const ids = picked.map((s) => s.id);
      tried.push(...ids);
      const result = await this.purgeRecords(tx, storage, ids, before, started);
      purged += result.records;
      count += result.contracts;
    }
    return count;
  }

  /** 고른 레코드(퇴직일 순)를 id 순으로 잠그고 지운다. 지운 레코드 수와 계약 수를 돌려준다. */
  private async purgeRecords(
    tx: Prisma.TransactionClient,
    storage: StorageService,
    picked: number[],
    before: Date,
    started: number,
  ): Promise<{ records: number; contracts: number }> {
    const lockedStaff = await tx.$queryRaw<{ id: number }[]>`
      SELECT s.staff_member_id AS id FROM staff_members s
      WHERE s.staff_member_id = ANY(${picked}::int[])
        AND s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
      ORDER BY s.staff_member_id
      FOR NO KEY UPDATE OF s
    `;
    const stillRetired = new Set(lockedStaff.map((s) => s.id));
    if (stillRetired.size === 0) return { records: 0, contracts: 0 };
    const locked = await tx.$queryRaw<{ id: number; staffMemberId: number }[]>`
      SELECT contract_id AS id, staff_member_id AS "staffMemberId" FROM contracts
      WHERE staff_member_id = ANY(${[...stillRetired]}::int[])
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
    if (blocked.size > 0)
      this.logger.log(
        `contract purge SKIPPED_PAYSLIP_AFTER_LOCK staff=${blocked.size}`,
      );
    // 파일은 퇴직일 순(고른 순서)으로 지운다 — 시간 상한에 걸리면 퇴직일이 늦은 쪽이 미뤄진다
    const purgeable = picked.filter(
      (id) => stillRetired.has(id) && !blocked.has(id),
    );
    const candidates = locked
      .filter((c) => purgeable.includes(c.staffMemberId))
      .map((c) => c.id);
    if (candidates.length === 0) return { records: 0, contracts: 0 };
    // 계약을 가리키는 행도 파일을 지우기 전에 잠근다 — 파일을 지운 뒤 남의 트랜잭션을 기다리다 60초를 넘기면 파일만 지워진다
    const schedules = await tx.$queryRaw<{ id: number; contractId: number }[]>`
      SELECT work_schedule_id AS id, source_contract_id AS "contractId" FROM work_schedules
      WHERE source_contract_id = ANY(${candidates}::int[])
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT 1 FROM staff_member_retirement_logs WHERE contract_id = ANY(${candidates}::int[]) FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT 1 FROM contracts WHERE previous_contract_id = ANY(${candidates}::int[]) FOR UPDATE
    `;

    const deferred = await this.deleteFiles(
      tx,
      storage,
      candidates,
      purgeable,
      started,
    );
    const done = purgeable.filter((id) => !deferred.has(id));
    const ids = locked
      .filter((c) => done.includes(c.staffMemberId))
      .map((c) => c.id);
    if (ids.length === 0) return { records: 0, contracts: 0 };
    await deleteWorkSchedules(
      tx,
      schedules.filter((s) => ids.includes(s.contractId)).map((s) => s.id),
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
    // 처리 시점 계약 종료일도 비운다 — CHECK(staff_member_retirement_logs_end_date_needs_contract)가 종료일만 남기를 막는다
    await tx.staffMemberRetirementLog.updateMany({
      where: { contractId: { in: ids } },
      data: { contractId: null, previousContractEndDate: null },
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
    return { records: done.length, contracts: count };
  }

  /**
   * 레코드 순서대로 계약서 파일을 지우고, 다음 날로 미룬 레코드를 돌려준다.
   * - 지우기 전에 그 레코드의 키를 모두 본다 — 저장소 키 형식이 아닌 것이 하나라도 있으면 하나도 지우지 않고 미룬다. 늘 같은
   *   이유로 실패하는 레코드가 파일 일부만 지워진 채(행은 남아 내려받기가 깨진 채) 남지 않게(api #238 리뷰). 사람이 봐야 할
   *   일이라 error 로그를 남긴다.
   * - 지우다 실패한 레코드(저장소 일시 장애)는 미루고 다음 레코드로 넘어간다. 일부 파일만 지워졌을 수 있지만 다음 날 다시
   *   지워 회복된다.
   * - 시간 상한을 넘으면 파일이 있는 남은 레코드는 모두 미루고, 파일이 없는 레코드는 그대로 지운다.
   */
  private async deleteFiles(
    tx: Prisma.TransactionClient,
    storage: StorageService,
    contractIds: number[],
    staffMemberIds: number[],
    started: number,
  ): Promise<Set<number>> {
    // 잠근 계약의 파일만 — 잠근 뒤 생긴 계약이 있어도 그 파일은 지우지 않는다(행은 남으니)
    const documents = await tx.contractDocument.findMany({
      where: { contractId: { in: contractIds } },
      select: {
        storageKey: true,
        contract: { select: { staffMemberId: true } },
      },
    });
    const deferred = new Set<number>();
    const defer = (staffMemberId: number, reason: string) => {
      deferred.add(staffMemberId);
      this.logger.error(
        `contract purge FILES_DEFERRED staff=${staffMemberId}: ${reason}`,
      );
    };
    for (const staffMemberId of staffMemberIds) {
      const keys = documents
        .filter((d) => d.contract.staffMemberId === staffMemberId)
        .map((d) => d.storageKey);
      if (keys.length === 0) continue;
      // 실패하지 않고 느리기만 해도 60초를 넘겨 롤백되면(파일만 지워짐) 다음 날도 같은 자리에서 넘긴다 — 기한을 두고 남은 것을 미룬다
      if (Date.now() - started > FILE_DELETE_BUDGET_MS) {
        defer(
          staffMemberId,
          `파일 삭제가 ${FILE_DELETE_BUDGET_MS}ms 를 넘었다`,
        );
        continue;
      }
      if (!keys.every((key) => StorageService.isStoredKey(key))) {
        defer(staffMemberId, '저장소 키 형식이 아닌 파일이 있어 지우지 않았다');
        continue;
      }
      try {
        // 계약서 파일은 썸네일이 없다(날인본 정리와 같다)
        await Promise.all(
          keys.map((key) => storage.delete(key, { thumbnail: false })),
        );
      } catch (e) {
        defer(staffMemberId, String(e));
      }
    }
    return deferred;
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
