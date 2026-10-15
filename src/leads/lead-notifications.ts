import type { Prisma } from '@prisma/client';

/**
 * 도입문의를 가리키는 운영 알림을 받는 사람 · 발송까지 지운다. 알림 본문에 문의자 이름 · 업종이 들어 있어, 도입문의를
 * 지우거나(#590) 1년 뒤 파기할 때 함께 지우지 않으면 파기가 아니다(운영 정책 CNT-11, 2026-10-15 재영). 알림은
 * 도입문의를 외래키 없이(`related_type = 'LEAD'`) 가리키고, 알림 쪽 외래키는 RESTRICT 라 발송 → 받는 사람 → 알림 순이다.
 */
export async function deleteLeadNotifications(
  tx: Prisma.TransactionClient,
  leadIds: number[],
): Promise<void> {
  if (leadIds.length === 0) return;
  const notification = { relatedType: 'LEAD', relatedId: { in: leadIds } };
  await tx.notificationDelivery.deleteMany({
    where: { notificationRecipient: { notification } },
  });
  await tx.notificationRecipient.deleteMany({ where: { notification } });
  await tx.notification.deleteMany({ where: notification });
}
