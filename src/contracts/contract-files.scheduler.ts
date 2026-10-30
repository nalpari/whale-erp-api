import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BATCH_JOB } from '../batch/batch-job-names';
import { ContractFilesService } from './contract-files.service';

@Injectable()
export class ContractFilesScheduler {
  private readonly logger = new Logger(ContractFilesScheduler.name);

  constructor(private readonly files: ContractFilesService) {}

  /**
   * 근로계약서 파일 채우기(WHALEERP-131) — 처리 완료본이 없는 체결 계약(날인이 먼저 나가 생긴 것 · 날인 직후 만들기 실패)과 발송
   * 뒤 하루 안인데 보낸 원본이 없는 계약을 만든다. 10분마다. 배치 락은 쓰지 않는다 — PDF 만들기가 락 트랜잭션(60초)에 들어가지
   * 않게, 겹쳐 돌면 고유 인덱스가 한 장만 남긴다. 앞 실행이 끝나기 전 다음 주기는 건너뛴다.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, {
    name: BATCH_JOB.CONTRACT_FILES,
    timeZone: 'Asia/Seoul',
    waitForCompletion: true,
  })
  async fill(): Promise<void> {
    const made = await this.files.fillMissing();
    if (made) this.logger.log(`contract files made=${made}`);
  }
}
