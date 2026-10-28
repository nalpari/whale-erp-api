import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { ExcelExportsService } from './excel-exports.service';

@Injectable()
export class ExcelExportsScheduler {
  private readonly logger = new Logger(ExcelExportsScheduler.name);

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
    const handled = await this.exports.processPending();
    // 매 분 도는 배치라 일이 있었을 때만 남긴다 — 배치가 살아 있는지 로그로 볼 수 있게.
    if (handled) this.logger.log(`excel export processed=${handled}`);
  }

  // 매일 04:30 — 자정 · 03:00 · 03:30 · 매월 1일 04:00 배치와 겹치지 않게. 건수는 runExclusive 가 남긴다.
  // 그 뒤 기한이 지난 예약 생성 파일을 S3 에서 지운다 — 락 트랜잭션(60초) 밖에서. 여러 인스턴스가 함께 지워도 S3 삭제는
  // 같은 결과다. 이력 파기가 실패해도 파일은 지운다(둘은 상관없고, 파일 쪽은 7일 창을 넘기면 영영 남는다). 실패는 그 뒤에
  // 다시 던져 배치 로그에 남긴다.
  @Cron('0 30 4 * * *', {
    name: BATCH_JOB.EXCEL_DOWNLOAD_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purge(): Promise<void> {
    let purgeError: Error | null = null;
    try {
      await this.lock.runExclusive(BATCH_JOB.EXCEL_DOWNLOAD_PURGE, (tx) =>
        this.exports.purgeExpired(tx),
      );
    } catch (error) {
      purgeError =
        error instanceof Error ? error : new Error('excel-download-purge 실패');
    }
    await this.exports.deleteExpiredFiles();
    if (purgeError) throw purgeError;
  }
}
