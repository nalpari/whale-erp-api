import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { TodoDueSoonService } from './todo-due-soon.service';

@Injectable()
export class TodoDueSoonScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly dueSoon: TodoDueSoonService,
  ) {}

  // 5분 간격이라 알림은 기준 시각보다 최대 5분 늦게 만들어진다.
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: BATCH_JOB.TODO_DUE_SOON,
    timeZone: 'Asia/Seoul',
  })
  async notifyDueSoon(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.TODO_DUE_SOON, (tx) =>
      this.dueSoon.notifyDueSoon(tx),
    );
  }
}
