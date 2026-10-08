import type { NotificationTemplateChannel } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TemplateSource, TemplateVariable } from './render-template';

export type SendableTemplate = TemplateSource & {
  /** 알림톡만. CHECK notification_templates_alimtalk_fields 가 ALIMTALK 행에 값을 보장한다 */
  kakaoTemplateCode: string | null;
};

/**
 * 발송할 수 있는 템플릿을 템플릿 코드로 찾는다. 없거나, 운영자가 껐거나
 * (`is_active = false`), 다른 채널의 템플릿이면 이유를 나눠 던진다 — 운영자가
 * 끈 것과 코드의 오타는 대처가 다르다.
 */
export async function findSendableTemplate(
  prisma: Pick<PrismaService, 'notificationTemplate'>,
  templateCode: string,
  channel: NotificationTemplateChannel,
): Promise<SendableTemplate> {
  const row = await prisma.notificationTemplate.findUnique({
    where: { templateCode },
  });
  if (!row) throw new Error(`템플릿 ${templateCode} 이(가) 없습니다`);
  if (!row.isActive)
    throw new Error(`템플릿 ${templateCode} 은(는) 사용하지 않는 상태입니다`);
  if (row.channel !== channel)
    throw new Error(
      `템플릿 ${templateCode} 은(는) ${channel} 이 아니라 ${row.channel} 채널입니다`,
    );
  return {
    templateCode,
    title: row.title,
    body: row.body,
    // CHECK notification_templates_variables_array 가 배열임을 보장한다.
    variables: row.variables as TemplateVariable[],
    kakaoTemplateCode: row.kakaoTemplateCode,
  };
}
