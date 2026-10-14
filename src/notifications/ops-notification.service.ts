import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NO_NUL } from '../common/no-nul';
import { findSendableTemplate } from '../notification-templates/find-template';
import { renderTemplate } from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import type { RelatedType } from './related-type';

export type NotifyInput = {
  /** 운영 알림 템플릿 코드(NTF_*). 문구는 이 템플릿에서 읽어 알림에 박아 둔다 */
  templateCode: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** 알림이 가리키는 업무 — 「근로계약 #41」 표시와 중복 방지에 쓴다 */
  related: { type: RelatedType; id: number };
  /**
   * 알림을 눌러 갈 관리자 웹 경로(예: `/contracts/41`). 알림을 만드는 업무 쪽이 자기 화면 경로를 넘긴다(NOTIFY-16).
   * 갈 화면이 없으면 빼면 된다 — 알림함이 「이동할 화면이 없습니다」를 보인다.
   */
  link?: string;
  /**
   * 사건 하나에 하나인 값. `{템플릿 코드}:{사건 키}` 가 dedupe_key 다. 같은 대상에서 되풀이될 수 있는
   * 사건(재발송 뒤 다시 만료 등)은 상태 이력 ID 처럼 사건마다 다른 값을 넘긴다.
   */
  eventKey: string;
  /** 받는 관리자. ./recipients 의 함수로 만든다 */
  recipients: number[];
};

export type NotifyResult = {
  notificationId: number;
  /** 받는 사람마다 한 행. 메일은 붙이지 않는다 — 필요하면 업무 쪽이 MailService 를 따로 부른다(운영 정책 NTF-03) */
  recipients: { notificationRecipientId: number; adminAccountId: number }[];
};

/**
 * 운영 알림의 공통 진입점. 업무 쪽은 사건이 커밋된 뒤 이 함수 하나를 부른다(WHALEERP-247).
 *
 * 어떤 실패에도 던지지 않는다 — 알림이 못 만들어져도 원래 업무의 결과는 그대로다(운영 정책 NTF-08). 실패는
 * 서버 로그에 템플릿 코드와 사건 키로 남긴다. 업무 트랜잭션 안에서 부르면 안 된다: 알림 쪽 오류가 업무
 * 트랜잭션을 되돌릴 수 있다.
 */
@Injectable()
export class OpsNotificationService {
  private readonly logger = new Logger(OpsNotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput): Promise<NotifyResult | null> {
    const { templateCode, eventKey, related } = input;
    const at = `template=${templateCode} event=${eventKey}`;
    const recipients = [...new Set(input.recipients)];
    if (recipients.length === 0) {
      this.logger.warn(`ops notification SKIPPED no recipients ${at}`);
      return null;
    }

    try {
      const template = await findSendableTemplate(
        this.prisma,
        templateCode,
        'NOTIFICATION',
      );
      const { subject, body } = renderTemplate(template, input.variables);
      const link = input.link ?? null;
      if (link !== null && !isInternalPath(link))
        // 알림은 만든다 — 링크가 틀렸다고 관리자가 사건을 놓치면 안 된다. 값은 로그에 남기지 않는다.
        this.logger.warn(
          `ops notification LINK DROPPED not an admin-web path ${at}`,
        );
      return await this.prisma.$transaction(async (tx) => {
        const { notificationId } = await tx.notification.create({
          data: {
            notificationTarget: 'ADMIN',
            templateCode,
            relatedType: related.type,
            relatedId: related.id,
            link: link !== null && isInternalPath(link) ? link : null,
            title: subject ?? '',
            body,
            dedupeKey: `${templateCode}:${eventKey}`,
          },
          select: { notificationId: true },
        });
        const rows = await tx.notificationRecipient.createManyAndReturn({
          data: recipients.map((adminAccountId) => ({
            notificationId,
            adminAccountId,
          })),
          select: { notificationRecipientId: true, adminAccountId: true },
        });
        // adminAccountId 는 위에서 넣은 값이라 null 이 아니다(운영 알림 행).
        return {
          notificationId,
          recipients: rows as NotifyResult['recipients'],
        };
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.debug(`ops notification DUPLICATE ${at}`);
        return null;
      }
      this.logger.error(`ops notification FAILED ${at}: ${reasonOf(e)}`);
      return null;
    }
  }
}

/**
 * 관리자 웹 안의 경로인가 — `/` 로 시작하고 `//`(다른 호스트)가 아니며 백슬래시 · 공백이 없다. DB CHECK 와 같은
 * 규칙에, Postgres text 가 받지 않는 NUL 도 뺀다 — 그대로 보내면 링크만이 아니라 알림 생성이 통째로 실패한다.
 */
export function isInternalPath(link: string): boolean {
  return (
    link.startsWith('/') &&
    !link.startsWith('//') &&
    !/[\\\s]/.test(link) &&
    NO_NUL.test(link)
  );
}

/**
 * 로그에 남길 실패 사유. Prisma 오류의 메시지에는 넣으려던 값(직원 이름 등)이 들어갈 수 있어 코드나 이름만 쓴다.
 * 템플릿 조회·렌더 오류는 값을 담지 않으므로 메시지를 쓴다.
 */
function reasonOf(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code;
  if (e instanceof Error)
    return e.constructor.name.startsWith('PrismaClient')
      ? e.constructor.name
      : e.message;
  return String(e);
}
