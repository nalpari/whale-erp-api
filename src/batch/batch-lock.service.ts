import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { BatchJobName } from './batch-job-names';

export type BatchRunResult = { ran: boolean; processed: number };

/**
 * 같은 크론이 인스턴스마다 동시에 발화해도, 겹치는 실행 중 하나만 작업하게 한다.
 * 설계: docs/batch/employment-contract-batch.md 4장.
 *
 * 막는 것은 동시 실행이지 사이클당 1회가 아니다. 늦게 발화한 인스턴스는 앞
 * 실행이 커밋해 락이 풀린 뒤 도착해 다시 실행할 수 있다. 그래서 `work` 는
 * 두 번 실행돼도 결과가 같아야 한다(멱등).
 */
@Injectable()
export class BatchLockService {
  private readonly logger = new Logger(BatchLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 잡 이름으로 트랜잭션 스코프 advisory lock 을 시도하고, 얻었을 때만 `work` 를
   * 같은 트랜잭션에서 실행한다. 못 얻으면 다른 실행이 지금 같은 잡을 돌리고
   * 있는 것이므로 `work` 는 호출조차 하지 않는다.
   *
   * `work` 는 받은 `tx` 로만 써야 한다. 주입받은 PrismaService 로 쓴 것은 이
   * 트랜잭션 밖이라 실패해도 롤백되지 않는다.
   *
   * 세션 스코프 락(pg_advisory_lock)을 쓰지 않는 이유: 풀링된 Prisma 는 잠근
   * 커넥션과 푸는 커넥션이 같다는 보장이 없어 락이 새어 나간다. 트랜잭션 스코프
   * 락은 COMMIT·ROLLBACK 과 함께 풀리므로 예외가 나도 따로 해제할 일이 없다.
   */
  async runExclusive(
    jobName: BatchJobName,
    work: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<BatchRunResult> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const [{ acquired }] = await tx.$queryRaw<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${jobName})) AS acquired
          `;
          if (!acquired) return { ran: false, processed: 0 };
          return { ran: true, processed: await work(tx) };
        },
        // 기본 timeout 5s 는 배치에 짧다. maxWait 는 락이 아니라 풀에서 커넥션을
        // 얻기까지의 대기다(기본 2s). 자정에 요청과 겹쳐 풀이 붐벼도 시작조차
        // 못 하고 실패하지 않게 조금 늘렸다.
        { timeout: 60_000, maxWait: 5_000 },
      );
      this.logger.log(
        result.ran
          ? `${jobName} RAN processed=${result.processed}`
          : `${jobName} SKIPPED_LOCKED`,
      );
      return result;
    } catch (e) {
      // 락은 트랜잭션 스코프라 따로 풀 일이 없다. 이 블록은 기록과 전파만 맡는다.
      // 다시 던지므로 크론에서는 @nestjs/schedule 이 한 번 더 로그한다.
      this.logger.error(
        `${jobName} FAILED`,
        e instanceof Error ? e.stack : String(e),
      );
      throw e;
    }
  }
}
