import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import {
  AttendancePurgeScheduler,
  purgeExpiredAttendanceRecords,
} from './attendance-purge';

describe('purgeExpiredAttendanceRecords', () => {
  const mockTx = (ids: number[] = [5, 9]) => ({
    $queryRaw: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    attendanceRecord: {
      updateMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: ids.length }),
    },
    locationAccessLog: { updateMany: jest.fn() },
    attendanceCorrection: { deleteMany: jest.fn() },
  });
  const run = (tx: ReturnType<typeof mockTx>, now: Date) =>
    purgeExpiredAttendanceRecords(
      tx as unknown as Prisma.TransactionClient,
      now,
    );
  const cutoffOf = (tx: ReturnType<typeof mockTx>) =>
    (tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, Date])[1];

  it('수신 시각으로 3년 지난 것을 잠그고, 짝 · 확인자료 연결을 비운 뒤 보정 이력 → 기록 순으로 지운다', async () => {
    const tx = mockTx();
    // 한국 2026-10-22 12:00 → 2023-10-22 한국 0시 앞에 받은 것만
    const count = await run(tx, new Date('2026-10-22T03:00:00Z'));
    const sql = (tx.$queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join(
      '?',
    );
    expect(sql).toContain('WHERE received_at <');
    expect(sql).toContain('ORDER BY received_at');
    expect(sql).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0]).toContain(5000);
    expect(cutoffOf(tx)).toEqual(new Date('2023-10-21T15:00:00.000Z'));
    const target = { in: [5, 9] };
    expect(tx.attendanceRecord.updateMany).toHaveBeenCalledWith({
      where: { checkInAttendanceRecordId: target },
      data: { checkInAttendanceRecordId: null },
    });
    expect(tx.locationAccessLog.updateMany).toHaveBeenCalledWith({
      where: { attendanceRecordId: target },
      data: { attendanceRecordId: null },
    });
    expect(tx.attendanceCorrection.deleteMany).toHaveBeenCalledWith({
      where: { attendanceRecordId: target },
    });
    expect(tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({
      where: { attendanceRecordId: target },
    });
    const order = [
      tx.attendanceRecord.updateMany,
      tx.locationAccessLog.updateMany,
      tx.attendanceCorrection.deleteMany,
      tx.attendanceRecord.deleteMany,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(count).toBe(2);
  });

  it('지울 것이 없으면 아무것도 바꾸지 않는다', async () => {
    const tx = mockTx([]);
    await expect(run(tx, new Date('2026-10-22T03:00:00Z'))).resolves.toBe(0);
    expect(tx.attendanceRecord.updateMany).not.toHaveBeenCalled();
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('한국 자정 직후(UTC 로는 전날)에도 한국 날짜로 센다', async () => {
    const tx = mockTx();
    await run(tx, new Date('2026-10-21T15:30:00Z')); // 한국 2026-10-22 00:30
    expect(cutoffOf(tx)).toEqual(new Date('2023-10-21T15:00:00.000Z'));
  });
});

describe('AttendancePurgeScheduler', () => {
  it('attendance-purge 락 안에서 파기한다', async () => {
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
        AttendancePurgeScheduler,
        { provide: BatchLockService, useValue: lock },
      ],
    }).compile();

    await module.get(AttendancePurgeScheduler).purge();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'attendance-purge',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('서울 시각 03:30 에 attendance-purge 이름으로 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      AttendancePurgeScheduler.prototype,
      'purge',
    )?.value as object;
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      {
        cronTime: '0 30 3 * * *',
        name: 'attendance-purge',
        timeZone: 'Asia/Seoul',
      },
    );
  });
});
