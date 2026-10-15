import type { Prisma } from '@prisma/client';
import { deleteLeadNotifications } from './lead-notifications';

describe('deleteLeadNotifications', () => {
  const txOf = () => ({
    notificationDelivery: { deleteMany: jest.fn() },
    notificationRecipient: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
  });
  const run = (tx: ReturnType<typeof txOf>, ids: number[]) =>
    deleteLeadNotifications(tx as unknown as Prisma.TransactionClient, ids);

  // 외래키가 RESTRICT 라 발송 → 받는 사람 → 알림 순으로 지워야 한다.
  it('도입문의를 가리키는 운영 알림을 받는 사람 · 발송까지 지운다', async () => {
    const tx = txOf();
    await run(tx, [7, 8]);
    const notification = { relatedType: 'LEAD', relatedId: { in: [7, 8] } };
    expect(tx.notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { notificationRecipient: { notification } },
    });
    expect(tx.notificationRecipient.deleteMany).toHaveBeenCalledWith({
      where: { notification },
    });
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: notification,
    });
    const [d] = tx.notificationDelivery.deleteMany.mock.invocationCallOrder;
    const [r] = tx.notificationRecipient.deleteMany.mock.invocationCallOrder;
    const [n] = tx.notification.deleteMany.mock.invocationCallOrder;
    expect(d).toBeLessThan(r);
    expect(r).toBeLessThan(n);
  });

  it('지운 도입문의가 없으면 묻지 않는다', async () => {
    const tx = txOf();
    await run(tx, []);
    expect(tx.notification.deleteMany).not.toHaveBeenCalled();
  });
});
