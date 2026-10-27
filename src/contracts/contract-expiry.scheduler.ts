import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { ContractNoticeService } from './contract-notice.service';
import {
  type ContractDailyResult,
  ContractExpiryService,
} from './contract-expiry.service';

/** 커밋 뒤 알림을 함께 보내는 수 — 관리자 몇 명에게 메일을 보내므로 SMTP 연결이 몰리지 않게 작게 둔다 */
const NOTICE_CONCURRENCY = 5;

@Injectable()
export class ContractExpiryScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly expiry: ContractExpiryService,
    private readonly notice: ContractNoticeService,
  ) {}

  /**
   * 근로계약 하루 배치(만료 · 초대 만료 · 종료 · 갱신 예정, WHALEERP-152). 바꾼 뒤 커밋되면 만료 · 갱신 예정을 관리자에게
   * 알린다(WHALEERP-154) — 트랜잭션 안에서 보내면 SMTP 시간만큼 그 계약들의 날인 · 재발송이 기다리고, 되돌려져도 메일은 나간다.
   * 알림은 하나씩 차례로 보낸다(실패해도 던지지 않는다).
   */
  // timeZone 을 빼면 서버 타임존 자정에 돈다.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: BATCH_JOB.CONTRACT_EXPIRE,
    timeZone: 'Asia/Seoul',
  })
  async expireContracts(): Promise<void> {
    // runExclusive 는 처리 건수만 돌려준다 — 커밋 뒤 알릴 것은 여기 담아 꺼낸다
    const held: { result?: ContractDailyResult } = {};
    const { ran } = await this.lock.runExclusive(
      BATCH_JOB.CONTRACT_EXPIRE,
      async (tx) => {
        const r = await this.expiry.runDaily(tx);
        held.result = r;
        return (
          r.expired.length +
          r.invitationsExpired +
          r.ended.length +
          r.renewalDue.length
        );
      },
    );
    const done = held.result;
    if (!ran || !done) return;
    // 몇 건씩 함께 보낸다 — 하나씩이면 첫 배포 날처럼 대상이 많을 때 SMTP 시간만큼 길어지고, 한 건이 멈추면 뒤가 모두 기다린다
    const sends = [
      ...done.expired.map(
        ({ contractId, historyId }) =>
          () =>
            this.notice.statusChanged('EXPIRED', contractId, historyId),
      ),
      ...done.renewalDue.map(
        (contractId) => () => this.notice.renewalDue(contractId),
      ),
    ];
    for (let i = 0; i < sends.length; i += NOTICE_CONCURRENCY)
      await Promise.all(
        sends.slice(i, i + NOTICE_CONCURRENCY).map((send) => send()),
      );
  }
}
