import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  renderTemplate,
  type TemplateSource,
  type TemplateVariable,
} from '../notification-templates/render-template';
import { reasonOf } from './ops-notification.service';

export type StaffNoticeInput = {
  /** 앱 푸시 템플릿 코드(PUSH_*) */
  templateCode: string;
  /** 받는 직원 계정 — 가입을 마친 계정만 넘긴다 */
  accountId: number;
  /** 알림이 가리키는 업무 — 알림함이 눌러 열 곳을 정한다(CONTRACT · PAYSLIP 등) */
  relatedType: string;
  relatedId: number;
  variables: Record<string, string>;
};

/**
 * 직원 알림 하나(#259) — 근로계약서 발송 · 급여명세서 발송이 부른다. 업무 저장 트랜잭션 안에서 부른다(저장이 되돌려지면
 * 알림도 없다). 템플릿으로 문구를 채워 직원 알림과 받는 사람 한 줄을 만들고, 템플릿의 수신 설정 묶음을 끈 직원이 아니면
 * 앱 푸시 발송 대기 한 줄을 남긴다(NTF-14 — 끈 직원도 알림함 줄은 남는다). 실제 앱 푸시는 아직 없다(#261 · #321).
 *
 * 템플릿을 쓸 수 없으면(없음 · 채널이 다름 · 사용 안 함 · 렌더 실패) 알림 없이 false — 운영자가 템플릿을 잘못 고쳐도
 * 관리자의 업무가 막히면 안 된다. 사용 안 함만 warn 이고 나머지는 고쳐야 할 일이라 error 다. DB 오류는 던진다.
 * 근무스케줄 저장 알림(work-schedule-notice.ts) · 수행 임박 알림과 같은 순서다.
 */
export async function noticeStaff(
  tx: Prisma.TransactionClient,
  logger: Logger,
  input: StaffNoticeInput,
): Promise<boolean> {
  const { templateCode } = input;
  const at = `${input.relatedType}=${input.relatedId}`;
  const row = await tx.notificationTemplate.findUnique({
    where: { templateCode },
  });
  if (!row || row.channel !== 'PUSH') {
    logger.error(
      `staff notice SKIPPED ${at} template ${templateCode}: ${row ? `channel ${row.channel}` : 'missing'}`,
    );
    return false;
  }
  if (!row.isActive) {
    logger.warn(
      `staff notice SKIPPED ${at} template ${templateCode}: inactive`,
    );
    return false;
  }
  const template: TemplateSource = {
    templateCode,
    title: row.title,
    body: row.body,
    // CHECK notification_templates_variables_array 가 배열임을 보장한다.
    variables: row.variables as TemplateVariable[],
  };
  let rendered: { subject: string | null; body: string };
  try {
    rendered = renderTemplate(template, input.variables);
    if (rendered.subject === null) throw new Error('제목이 없습니다');
  } catch (e) {
    logger.error(
      `staff notice SKIPPED ${at} template ${templateCode}: cannot render — ${reasonOf(e)}`,
    );
    return false;
  }

  const notification = await tx.notification.create({
    data: {
      notificationTarget: 'STAFF',
      templateCode,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      title: rendered.subject,
      body: rendered.body,
    },
    select: { notificationId: true },
  });
  const recipient = await tx.notificationRecipient.create({
    data: {
      notificationId: notification.notificationId,
      accountId: input.accountId,
    },
    select: { notificationRecipientId: true },
  });
  // PUSH 템플릿이면 CHECK notification_templates_preference_category_push_only 가 묶음 값이 있음을 보장한다. 설정 행이
  // 없으면 켠 것이다
  const off = await tx.notificationPreference.findFirst({
    where: {
      accountId: input.accountId,
      preferenceCategory: row.preferenceCategory!,
      isEnabled: false,
    },
    select: { accountId: true },
  });
  if (!off)
    await tx.notificationDelivery.create({
      data: {
        notificationRecipientId: recipient.notificationRecipientId,
        channel: 'PUSH',
      },
    });
  return true;
}
