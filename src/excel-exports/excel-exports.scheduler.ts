import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { ExcelExportsService } from './excel-exports.service';

@Injectable()
export class ExcelExportsScheduler {
  constructor(
    private readonly lock: BatchLockService,
    private readonly exports: ExcelExportsService,
  ) {}

  // 1분마다 예약 생성을 처리한다. 작업마다 행 잠금(FOR UPDATE SKIP LOCKED)으로 가져가 인스턴스가 여럿이어도 한 번만
  // 만든다 — 파일 만들기 · S3 · 메일이 runExclusive 의 한 트랜잭션(60초)에 들어가지 않게 배치 락은 쓰지 않는다.
  // timeZone 을 빼면 서버 타임존에 돈다. 앞 실행이 끝나기 전에 다음 분이 오면 건너뛴다(waitForCompletion) — 한
  // 인스턴스 안에서 겹쳐 돌지 않게. 인스턴스끼리는 시도 횟수를 조건으로 한 상태 전이(settle)가 막는다.
  @Cron(CronExpression.EVERY_MINUTE, {
    name: BATCH_JOB.EXCEL_EXPORT,
    timeZone: 'Asia/Seoul',
    waitForCompletion: true,
  })
  async processPending(): Promise<void> {
    await this.exports.processPending();
  }

  // 매일 04:30 — 자정 · 03:00 · 03:30 · 매월 1일 04:00 배치와 겹치지 않게. 건수는 runExclusive 가 남긴다.
  // 그 뒤 기한이 지난 예약 생성 파일을 S3 에서 지운다 — 락 트랜잭션(60초) 밖에서. 여러 인스턴스가 함께 지워도 S3 삭제는
  // 같은 결과다.
  @Cron('0 30 4 * * *', {
    name: BATCH_JOB.EXCEL_DOWNLOAD_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.EXCEL_DOWNLOAD_PURGE, (tx) =>
      this.exports.purgeExpired(tx),
    );
    await this.exports.deleteExpiredFiles();
  }
}
