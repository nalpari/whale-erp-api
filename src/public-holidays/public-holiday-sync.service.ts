import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { HolidayApiClient, type ApiHoliday } from './holiday-api.client';
import { planPublicHolidaySync } from './public-holiday-sync-plan';
import { syncYearsOf } from './public-holiday-years';

// 오류 칸은 TEXT 지만 화면 · 로그가 읽을 만한 길이로 자른다.
const ERROR_MAX = 2_000;

/**
 * 올해 · 다음 해 공식 휴일 동기화(WHALEERP-543). 공휴일 API 로 연도를 통째로 받아 public_holidays 와 맞추고
 * 연도마다 public_holiday_synchronization_logs 에 한 줄을 남긴다. 맞추는 규칙은 planPublicHolidaySync.
 *
 * API 는 트랜잭션 밖에서 먼저 부른다 — 외부 호출을 기다리는 동안 커넥션 · 락을 쥐지 않게. 반영과 성공 이력은
 * runExclusive 의 한 트랜잭션이라, 같은 동기화가 두 인스턴스에서 겹치면 하나만 쓴다(명세의 「중복 실행
 * 방지」). 늦게 도착한 인스턴스가 앞 실행 뒤에 다시 돌 수는 있는데, 그때는 바꿀 것이 없어 0건 이력이 한 줄 더 남는다.
 */
@Injectable()
export class PublicHolidaySyncService {
  private readonly logger = new Logger(PublicHolidaySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: BatchLockService,
    private readonly client: HolidayApiClient,
  ) {}

  /**
   * 한국 날짜의 올해와 다음 해를 차례로(2050년을 넘는 해는 건너뛴다 — 테이블 범위 밖). 한 해가 실패해도 다른 해는 돈다 — 실패는 이력에 남고, 그 이력조차 쓰지
   * 못하면(DB 다운) 로그로만 남긴다.
   */
  async syncAll(now: Date = new Date()): Promise<void> {
    const thisYear = kstToday(now).getUTCFullYear();
    for (const year of syncYearsOf(thisYear)) {
      try {
        await this.syncYear(year, now);
      } catch (e) {
        this.logger.error(
          `${year} 공휴일 동기화의 실패 이력도 남기지 못했다`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }
  }

  /** 한 해를 맞춘다. API · 반영 실패는 던지지 않고 그 해의 실패 이력으로 남긴다(그 이력조차 못 쓰면 던진다). */
  async syncYear(year: number, now: Date = new Date()): Promise<void> {
    let fetched: ApiHoliday[];
    try {
      fetched = await this.client.fetchYear(year);
    } catch (e) {
      // 받지 못했으면 테이블은 그대로 둔다.
      await this.recordFailure(year, now, e);
      return;
    }
    try {
      await this.lock.runExclusive(BATCH_JOB.PUBLIC_HOLIDAY_SYNC, (tx) =>
        this.apply(tx, year, fetched, now),
      );
    } catch (e) {
      // runExclusive 가 되돌리고 로그를 남겼다 — 그 해의 실패 이력만 남긴다.
      await this.recordFailure(year, now, e);
    }
  }

  private async apply(
    tx: Prisma.TransactionClient,
    year: number,
    fetched: ApiHoliday[],
    now: Date,
  ): Promise<number> {
    const stored = await tx.publicHoliday.findMany({
      where: { year },
      select: {
        publicHolidayId: true,
        holidayDate: true,
        name: true,
        note: true,
        source: true,
        sourceRef: true,
      },
    });
    const plan = planPublicHolidaySync(year, stored, fetched);

    if (plan.create.length)
      await tx.publicHoliday.createMany({
        data: plan.create.map((c) => ({
          holidayDate: c.holidayDate,
          year,
          name: c.name,
          note: null,
          source: 'PUBLIC_API' as const,
          sourceRef: c.sourceRef,
          synchronizedAt: now,
        })),
      });
    for (const u of plan.update)
      await tx.publicHoliday.update({
        where: { publicHolidayId: u.publicHolidayId },
        data: {
          name: u.name,
          note: null,
          source: 'PUBLIC_API',
          sourceRef: u.sourceRef,
          synchronizedAt: now,
        },
      });
    if (plan.refresh.length)
      await tx.publicHoliday.updateMany({
        where: { publicHolidayId: { in: plan.refresh } },
        data: { synchronizedAt: now },
      });
    if (plan.remove.length)
      await tx.publicHoliday.deleteMany({
        where: { publicHolidayId: { in: plan.remove } },
      });

    await tx.publicHolidaySynchronizationLog.create({
      data: {
        year,
        synchronizedAt: now,
        createdCount: plan.create.length,
        updatedCount: plan.update.length,
        deletedCount: plan.remove.length,
        failedCount: plan.errors.length,
        error: plan.errors.length
          ? plan.errors.join('\n').slice(0, ERROR_MAX)
          : null,
        result: 'SUCCEEDED',
      },
    });
    if (plan.errors.length)
      this.logger.warn(
        `${year} 공휴일 원본 ${plan.errors.length}건을 반영하지 않았다`,
      );
    return plan.create.length + plan.update.length + plan.remove.length;
  }

  private async recordFailure(year: number, now: Date, e: unknown) {
    const message = (e instanceof Error ? e.message : String(e)).slice(
      0,
      ERROR_MAX,
    );
    this.logger.warn(`${year} 공휴일 동기화 실패: ${message}`);
    await this.prisma.publicHolidaySynchronizationLog.create({
      data: { year, synchronizedAt: now, error: message, result: 'FAILED' },
    });
  }
}
