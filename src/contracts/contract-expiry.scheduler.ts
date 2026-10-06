import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { ContractExpiryService } from './contract-expiry.service';

@Injectable()
export class ContractExpiryScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly expiry: ContractExpiryService,
  ) {}

  // timeZone 을 빼면 서버 타임존 자정에 돈다.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: BATCH_JOB.CONTRACT_EXPIRE,
    timeZone: 'Asia/Seoul',
  })
  async expireContracts(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.CONTRACT_EXPIRE, (tx) =>
      this.expiry.expireOverdue(tx),
    );
  }
}
