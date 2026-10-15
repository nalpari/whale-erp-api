import type { Prisma } from '@prisma/client';
import { PLATFORM_BP_CODE } from '../code-groups/code-format';
import {
  type OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { platformOperators } from '../notifications/recipients';
import type { PrismaService } from '../prisma/prisma.service';
import { INDUSTRY_OTHER } from './dto/create-lead.dto';

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

type LeadContact = {
  contactName: string;
  industryCode: string;
  industryDetail: string | null;
};

/**
 * 템플릿 변수 「도입문의자」(도입문의 이름·업종)의 값 — `김도윤 · 카페`. 업종은 기타면 직접 입력한 값, 아니면 공통코드
 * 이름(사용 중지된 코드도 이름은 쓴다), 없으면 코드.
 */
async function leadContact(
  prisma: Pick<PrismaService, 'codeItem'>,
  lead: LeadContact,
): Promise<string> {
  return `${lead.contactName} · ${await industryOf(prisma, lead)}`;
}

async function industryOf(
  prisma: Pick<PrismaService, 'codeItem'>,
  lead: LeadContact,
): Promise<string> {
  if (lead.industryCode === INDUSTRY_OTHER && lead.industryDetail)
    return lead.industryDetail;
  const item = await prisma.codeItem.findFirst({
    where: {
      groupCode: 'INDUSTRY',
      itemCode: lead.industryCode,
      bpCode: PLATFORM_BP_CODE,
    },
    select: { label: true },
  });
  return item?.label ?? lead.industryCode;
}

/**
 * 도입문의 하나를 플랫폼 운영자에게 운영 알림으로 알린다 — 접수(`NTF_LEAD_RECEIVED`, #296)와 처리 상태 변경
 * (`NTF_LEAD_ANSWERED`). 「도입문의자」 변수는 여기서 채운다. 도입문의가 없으면 보내지 않는다. 실패는 던지므로
 * 커밋 뒤에 부르는 쪽이 잡는다.
 */
export async function notifyLeadOperators(
  prisma: PrismaService,
  ops: OpsNotificationService,
  leadId: number,
  input: {
    templateCode: string;
    eventKey: string;
    variables?: Record<string, string>;
  },
): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { leadId },
    select: { contactName: true, industryCode: true, industryDetail: true },
  });
  if (!lead) return;
  await ops.notify({
    templateCode: input.templateCode,
    variables: {
      ...input.variables,
      도입문의자: await leadContact(prisma, lead),
    },
    related: { type: 'LEAD', id: leadId },
    link: `/platform/community/leads/${leadId}`,
    eventKey: input.eventKey,
    recipients: await platformOperators(prisma),
  });
  // 위에서 읽은 뒤 지우기(#590)가 커밋됐으면 방금 만든 알림에 지운 문의자 이름이 남는다. FOR SHARE 라 지우는
  // 중이면 끝나기를 기다려 본다. 지우기가 먼저 알림을 지웠어도 이 알림은 그 뒤에 생겼을 수 있다.
  const still = await prisma.$queryRaw<{ leadId: number }[]>`
    SELECT "lead_id" AS "leadId" FROM "leads" WHERE "lead_id" = ${leadId} FOR SHARE
  `;
  if (still.length === 0)
    await prisma
      .$transaction((tx) => deleteLeadNotifications(tx, [leadId]))
      .catch((e: unknown) => {
        // 「알림 실패」와 다르다 — 지운 문의자 이름이 든 알림이 남았다(CNT-11). 다시 치울 길이 없어 손으로 지운다.
        throw new Error(
          `CLEANUP FAILED, 알림을 손으로 지워야 한다: ${reasonOf(e)}`,
        );
      });
}
