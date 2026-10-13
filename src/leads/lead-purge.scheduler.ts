import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { LeadsService } from './leads.service';

@Injectable()
export class LeadPurgeScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly leads: LeadsService,
  ) {}

  // timeZone 을 빼면 서버 타임존 자정에 돈다.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: BATCH_JOB.LEAD_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.LEAD_PURGE, (tx) =>
      this.leads.purgeExpired(tx),
    );
  }
}
