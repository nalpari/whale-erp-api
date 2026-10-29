import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { BulkExportsService } from './bulk-exports.service';

@Injectable()
export class BulkExportsScheduler {
  private readonly logger = new Logger(BulkExportsScheduler.name);

  constructor(
    private readonly lock: BatchLockService,
    private readonly exports: BulkExportsService,
  ) {}

  // 1분마다 대기 요청을 만든다. 작업마다 행 잠금(SKIP LOCKED)으로 집어 인스턴스가 여럿이어도 한 번만 — zip 만들기가 배치 락의
  // 트랜잭션(60초)에 들어가지 않게 배치 락은 쓰지 않는다(공통 엑셀과 같다). 앞 실행이 끝나기 전 다음 분은 건너뛴다.
  @Cron(CronExpression.EVERY_MINUTE, {
    name: BATCH_JOB.BULK_EXPORT,
    timeZone: 'Asia/Seoul',
    waitForCompletion: true,
  })
  async processPending(): Promise<void> {
    const handled = await this.exports.processPending();
    if (handled) this.logger.log(`bulk export processed=${handled}`);
  }

  // 매일 04:40 — 04:30 엑셀 정리와 겹치지 않게. 기한이 지난 파일을 지우고 storage_key 를 비운다.
  @Cron('0 40 4 * * *', {
    name: BATCH_JOB.BULK_EXPORT_FILE_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.BULK_EXPORT_FILE_PURGE, (tx) =>
      this.exports.purgeExpiredFiles(tx),
    );
  }
}
