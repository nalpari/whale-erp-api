import { CronExpression } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import {
  purgeExpiredWorkSchedules,
  WorkSchedulePurgeScheduler,
} from './work-schedule-purge';

describe('purgeExpiredWorkSchedules', () => {
  const mockTx = (ids: number[] = [5, 9]) => ({
    $queryRaw: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    notificationDelivery: { deleteMany: jest.fn() },
    notificationRecipient: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    workScheduleHistory: {
      deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
    },
    workSchedule: {
      deleteMany: jest.fn().mockResolvedValue({ count: ids.length }),
    },
  });
  const run = (tx: ReturnType<typeof mockTx>, now: Date) =>
    purgeExpiredWorkSchedules(tx as unknown as Prisma.TransactionClient, now);
  /** 대상 잠금 쿼리에 넘긴 기준 시각 */
  const cutoffOf = (tx: ReturnType<typeof mockTx>) =>
    (tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, Date])[1];

  it('대상을 먼저 FOR UPDATE 로 잠그고, 그 ID 로 이력 → 근무스케줄 순으로 지운다', async () => {
    const tx = mockTx();
    // 한국 2026-10-21 12:00 → 2023-10-21 한국 0시 앞에 만든 것만
    const count = await run(tx, new Date('2026-10-21T03:00:00Z'));
    const sql = (tx.$queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join(
      '?',
    );
    expect(sql).toContain('FOR UPDATE');
    expect(cutoffOf(tx)).toEqual(new Date('2023-10-20T15:00:00.000Z'));
    expect(tx.workScheduleHistory.deleteMany).toHaveBeenCalledWith({
      where: { workScheduleId: { in: [5, 9] } },
    });
    expect(tx.workSchedule.deleteMany).toHaveBeenCalledWith({
      where: { workScheduleId: { in: [5, 9] } },
    });
    expect(
      tx.workScheduleHistory.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.workSchedule.deleteMany.mock.invocationCallOrder[0]);
    expect(count).toBe(2);
  });

  it('그 근무스케줄을 가리키는 저장 알림도 발송 → 받는 사람 → 알림 순으로 지운다(Q13)', async () => {
    const tx = mockTx();
    await run(tx, new Date('2026-10-21T03:00:00Z'));
    const notification = {
      relatedType: 'WORK_SCHEDULE',
      relatedId: { in: [5, 9] },
    };
    expect(tx.notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { notificationRecipient: { notification } },
    });
    expect(tx.notificationRecipient.deleteMany).toHaveBeenCalledWith({
      where: { notification },
    });
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: notification,
    });
    const order = [
      tx.notificationDelivery.deleteMany,
      tx.notificationRecipient.deleteMany,
      tx.notification.deleteMany,
      tx.workSchedule.deleteMany,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('지울 것이 없으면 지우지 않는다', async () => {
    const tx = mockTx([]);
    await expect(run(tx, new Date('2026-10-21T03:00:00Z'))).resolves.toBe(0);
    expect(tx.workSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('한국 자정 직후(UTC 로는 전날)에도 한국 날짜로 센다', async () => {
    const tx = mockTx();
    await run(tx, new Date('2026-10-20T15:30:00Z')); // 한국 2026-10-21 00:30
    expect(cutoffOf(tx)).toEqual(new Date('2023-10-20T15:00:00.000Z'));
  });

  it('윤년 — 2월 29일에 만든 것은 3년 뒤 2월 28일까지 남고, 기준은 하루씩만 움직인다', async () => {
    const feb28 = mockTx();
    await run(feb28, new Date('2027-02-27T15:30:00Z')); // 한국 2027-02-28
    expect(cutoffOf(feb28)).toEqual(new Date('2024-02-27T15:00:00.000Z')); // 2024-02-28 한국 0시
    const mar1 = mockTx();
    await run(mar1, new Date('2027-02-28T15:30:00Z')); // 한국 2027-03-01
    expect(cutoffOf(mar1)).toEqual(new Date('2024-02-29T15:00:00.000Z')); // 2024-03-01 한국 0시
  });
});

describe('WorkSchedulePurgeScheduler', () => {
  it('work-schedule-purge 락 안에서 파기한다', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const lock = {
      runExclusive: jest.fn(
        async (_name: string, work: (t: object) => Promise<number>) => ({
          ran: true,
          processed: await work(tx),
        }),
      ),
    };
    const module = await Test.createTestingModule({
      providers: [
        WorkSchedulePurgeScheduler,
        { provide: BatchLockService, useValue: lock },
      ],
    }).compile();

    await module.get(WorkSchedulePurgeScheduler).purge();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'work-schedule-purge',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('서울 시각 03:00 에 work-schedule-purge 이름으로 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      WorkSchedulePurgeScheduler.prototype,
      'purge',
    )?.value as object;
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      {
        cronTime: CronExpression.EVERY_DAY_AT_3AM,
        name: 'work-schedule-purge',
        timeZone: 'Asia/Seoul',
      },
    );
  });
});
