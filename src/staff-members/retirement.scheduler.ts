import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { kstToday } from './kst-date';
import { RetirementService } from './retirement.service';

@Injectable()
export class RetirementScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly retirement: RetirementService,
  ) {}

  // 한국 자정에 돈다. 퇴직일 당일까지는 재직이고, 다음 날 0시부터 퇴직이다.
  // timeZone 을 빼면 서버 타임존 자정에 돈다.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: BATCH_JOB.STAFF_RETIRE,
    timeZone: 'Asia/Seoul',
  })
  async retireDue(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.STAFF_RETIRE, (tx) =>
      this.retirement.retireDue(tx, kstToday()),
    );
  }
}
