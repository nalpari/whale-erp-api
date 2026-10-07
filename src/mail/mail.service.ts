import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import { MAIL_CONFIG, type MailConfig } from './mail.config';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type MailSendResult = {
  /** SMTP 서버가 받은 메시지의 Message-ID */
  messageId: string;
};

const FROM_NAME = 'Whale ERP';
// 주소 하나만 받는다. 쉼표·세미콜론이 있으면 nodemailer 가 받는 사람을 여럿으로
// 나누고, 꺾쇠·따옴표는 표시 이름으로 읽고, 콜론·괄호·역슬래시는 그룹·주석
// 문법이라 검사한 주소와 실제 받는 주소가 달라진다.
const EMAIL = /^[^\s@,;<>"():\\]+@[^\s@,;<>"():\\]+\.[^\s@,;<>"():\\]+$/;

/**
 * 메일 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 문구는 `notification_templates` 의 EMAIL 템플릿이고, 본문은 텍스트로 보낸다.
 * SMTP 서버(Gmail)가 받을 때까지만 책임진다. 받은 뒤 반송되는 것은 모른다.
 * 타임아웃(ETIMEDOUT)은 「안 갔다」가 아니다 — 본문을 보낸 뒤 끊겼으면 Gmail 이
 * 이미 받았을 수 있으니, 자동으로 다시 보내면 임시 비밀번호가 두 번 나갈 수 있다.
 * 실패는 던지므로, 발송이 본 작업을 막으면 안 되는 곳은 호출부에서 잡는다.
 * DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤 부른다.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT)
    private readonly transport: Pick<Transporter, 'sendMail'>,
    @Inject(MAIL_CONFIG)
    private readonly config: Pick<MailConfig, 'username'>,
    private readonly templates: NotificationTemplatesService,
  ) {}

  async send(
    templateCode: string,
    to: string,
    variables: Record<string, string>,
  ): Promise<MailSendResult> {
    if (!EMAIL.test(to))
      throw new Error(`메일 주소가 아닙니다: ${maskEmail(to)}`);
    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const { title, body } = await this.templates.render(
      templateCode,
      'EMAIL',
      variables,
    );

    try {
      const info = (await this.transport.sendMail({
        from: { name: FROM_NAME, address: this.config.username },
        to,
        // render 가 EMAIL 행의 제목을 확인했다.
        subject: title as string,
        text: body,
      })) as { messageId: string };
      this.logger.log(
        `mail ACCEPTED template=${templateCode} messageId=${info.messageId} to=${maskEmail(to)}`,
      );
      return { messageId: info.messageId };
    } catch (e) {
      const { code: smtpCode, responseCode } = e as {
        code?: string;
        responseCode?: number;
      };
      this.logger.warn(
        `mail FAILED template=${templateCode} code=${smtpCode} response=${responseCode} to=${maskEmail(to)}: ${(e as Error).message}`,
      );
      throw e;
    }
  }
}

/** hong@example.com → h***@example.com */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}
