import type { MailService } from '../mail/mail.service';
import {
  PasswordResetLinkMail,
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from './password-reset-link-sender';

/**
 * 재설정 링크를 메일로 보낸다(템플릿 `EMAIL_STAFF_RESET_LINK`, 변수 근무지 · 링크). 링크 변수는 버튼 링크라
 * MailService 가 발송 이력(`mail_send_logs`)에 가려 남긴다 — 토큰 원문이 이력에 남지 않는다.
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
      sentBy: content.requestedBy,
    });
  }
}
