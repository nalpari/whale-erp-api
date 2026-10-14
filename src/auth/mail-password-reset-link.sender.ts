import type { MailService } from '../mail/mail.service';
import {
  PasswordResetLinkMail,
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from './password-reset-link-sender';

/**
 * 재설정 링크를 메일로 보낸다(템플릿 `EMAIL_STAFF_RESET_LINK`, 변수 근무지 · 링크). 링크는 발송 이력
 * (`mail_send_logs`)에서 가린다. 템플릿의 버튼 링크 표시에만 기대지 않고 직접 넘긴다 — 운영자가 그 표시를 끄고
 * 본문에 `#{링크}` 를 넣어도 토큰 원문이 이력에 1년 남지 않게(api #28 리뷰).
 */
export class MailPasswordResetLinkSender extends PasswordResetLinkSender {
  constructor(private readonly mail: Pick<MailService, 'send'>) {
    super();
  }

  isAvailable(): boolean {
    return true;
  }

  async send(
    target: PasswordResetLinkTarget,
    content: PasswordResetLinkMail,
  ): Promise<void> {
    await this.mail.send({
      templateCode: 'EMAIL_STAFF_RESET_LINK',
      to: target.email,
      variables: { 근무지: content.storeName, 링크: content.link },
      maskedVariables: ['링크'],
      sentBy: content.requestedBy,
    });
  }
}
