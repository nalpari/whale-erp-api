import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { PublicHolidaySyncService } from './public-holiday-sync.service';

@Injectable()
export class PublicHolidaySyncScheduler {
  constructor(private readonly sync: PublicHolidaySyncService) {}

  // 매월 1일 04:00(한국) — 자정 · 03:00 · 03:30 의 다른 배치와 겹치지 않게. 월중에 지정된 임시공휴일은
  // 다음 달 1일에 들어온다(명세). timeZone 을 빼면 서버 타임존에 돈다.
  @Cron('0 0 4 1 * *', {
    name: BATCH_JOB.PUBLIC_HOLIDAY_SYNC,
    timeZone: 'Asia/Seoul',
  })
  async synchronize(): Promise<void> {
    await this.sync.syncAll();
  }
}
