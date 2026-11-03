import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import { PayslipPurgeScheduler, purgeExpiredPayslips } from './payslip-purge';

describe('purgeExpiredPayslips', () => {
  const mockTx = (ids: number[] = [5, 9]) => ({
    $queryRaw: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    payslipItem: { deleteMany: jest.fn() },
    payslipReviewReason: { deleteMany: jest.fn() },
    payslipDispatch: { deleteMany: jest.fn() },
    payslipLog: { deleteMany: jest.fn() },
    notificationDelivery: { deleteMany: jest.fn() },
    notificationRecipient: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    payslip: {
      deleteMany: jest.fn().mockResolvedValue({ count: ids.length }),
    },
  });
  const run = (tx: ReturnType<typeof mockTx>, now: Date) =>
    purgeExpiredPayslips(tx as unknown as Prisma.TransactionClient, now);

  it('생성일로 3년 지난 것을 잠그고, 딸린 행 · 알림을 지운 뒤 명세서를 지운다', async () => {
    const tx = mockTx();
    // 한국 2026-11-03 12:00 → 2023-11-03 한국 0시 앞에 만든 것만
    await expect(run(tx, new Date('2026-11-03T03:00:00Z'))).resolves.toBe(2);
    const [strings, cutoff, limit] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    const sql = strings.join('?');
    expect(sql).toContain('WHERE created_at <');
    expect(sql).toContain('ORDER BY created_at, payslip_id');
    expect(sql).toContain('FOR UPDATE');
    expect(cutoff).toEqual(new Date('2023-11-02T15:00:00.000Z'));
    expect(limit).toBe(5000);

    const owned = { where: { payslipId: { in: [5, 9] } } };
    for (const m of [
      tx.payslipItem,
      tx.payslipReviewReason,
      tx.payslipDispatch,
      tx.payslipLog,
      tx.payslip,
    ])
      expect(m.deleteMany).toHaveBeenCalledWith(owned);
    const notification = { relatedType: 'PAYSLIP', relatedId: { in: [5, 9] } };
    expect(tx.notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { notificationRecipient: { notification } },
    });
    expect(tx.notificationRecipient.deleteMany).toHaveBeenCalledWith({
      where: { notification },
    });
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: notification,
    });
    // 외래키가 RESTRICT 라 가리키는 쪽부터 — 명세서는 마지막
    const order = [
      tx.payslipItem.deleteMany,
      tx.payslipReviewReason.deleteMany,
      tx.payslipDispatch.deleteMany,
      tx.payslipLog.deleteMany,
      tx.notificationDelivery.deleteMany,
      tx.notificationRecipient.deleteMany,
      tx.notification.deleteMany,
      tx.payslip.deleteMany,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('대상이 없으면 아무것도 지우지 않는다', async () => {
    const tx = mockTx([]);
    await expect(run(tx, new Date())).resolves.toBe(0);
    expect(tx.payslipItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.payslip.deleteMany).not.toHaveBeenCalled();
  });
});

describe('PayslipPurgeScheduler', () => {
  it('배치 잠금 안에서 payslip-purge 로 명세서 파기를 돌린다', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const runExclusive = jest.fn(
      (_name: string, work: (t: typeof tx) => Promise<number>) => work(tx),
    );
    await new PayslipPurgeScheduler({
      runExclusive,
    } as unknown as BatchLockService).purge();
    expect(runExclusive).toHaveBeenCalledWith(
      'payslip-purge',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
