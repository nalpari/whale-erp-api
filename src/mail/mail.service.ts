import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG, type MailConfig } from './mail.config';
import { type TemplateVariable, renderMail } from './render-template';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type SendMailInput = {
  /** notification_templates.template_code. EMAIL 채널이어야 한다 */
  templateCode: string;
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** mail_send_logs 에 ******** 로 남길 변수 — 임시 비밀번호 · 핀 등 */
  maskedVariables?: readonly string[];
  /** 받는 사람이 관리자 계정일 때 */
  adminAccountId?: number;
  /** 관리자가 대신 보냈을 때. 본인 요청이면 비운다 */
  sentBy?: number;
};

export type MailSendResult = {
  /** SMTP 서버가 받은 메시지의 Message-ID */
  messageId: string;
};

const FROM_NAME = 'WHALE ERP';
// 주소 하나만 받는다. 쉼표·세미콜론이 있으면 nodemailer 가 받는 사람을 여럿으로
// 나누고, 꺾쇠·따옴표는 표시 이름으로 읽고, 콜론·괄호·역슬래시는 그룹·주석
// 문법이라 검사한 주소와 실제 받는 주소가 달라진다.
// 자유 문장 속 주소 모양. 로그에서 가릴 때만 쓴다.
const ADDRESS_IN_TEXT = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;
const EMAIL = /^[^\s@,;<>"():\\]+@[^\s@,;<>"():\\]+\.[^\s@,;<>"():\\]+$/;

/**
 * 메일 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * `notification_templates` 의 EMAIL 템플릿(완성된 HTML)을 채워 Gmail SMTP 로 보내고,
 * 시도마다 `mail_send_logs` 에 한 행을 남긴다. 보내기 전 검증에 걸리면 보낸 것이
 * 없으므로 기록도 없다.
 *
 * SMTP 서버가 받을 때까지만 책임진다. 타임아웃은 「안 갔다」가 아니다 — 본문을
 * 보낸 뒤 끊겼으면 Gmail 이 이미 받았을 수 있어 자동으로 다시 보내지 않는다.
 * 실패는 던지므로, 발송이 본 작업을 막으면 안 되는 곳은 호출부에서 잡는다.
 * DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤 부른다 — 롤백돼도 메일은 이미 나간다.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT)
    private readonly transport: Pick<Transporter, 'sendMail'>,
    @Inject(MAIL_CONFIG)
    private readonly config: Pick<MailConfig, 'username'>,
    private readonly prisma: PrismaService,
  ) {}

  async send(input: SendMailInput): Promise<MailSendResult> {
    const { templateCode, to } = input;
    if (!EMAIL.test(to))
      throw new Error(`메일 주소가 아닙니다: ${maskEmail(to)}`);

    const template = await this.prisma.notificationTemplate.findUnique({
      where: { templateCode },
    });
    if (
      !template ||
      !template.isActive ||
      template.channel !== 'EMAIL' ||
      template.title === null
    )
      throw new Error(
        `메일 템플릿 ${templateCode} 이(가) 없거나 쓸 수 없습니다`,
      );

    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const mail = renderMail(
      {
        templateCode,
        title: template.title,
        body: template.body,
        // CHECK notification_templates_variables_array 가 배열임을 보장한다.
        variables: template.variables as TemplateVariable[],
      },
      input.variables,
      input.maskedVariables,
    );

    // 이력에는 가린 제목·본문만 넘긴다 — record 가 보낸 원문에 손댈 수 없게.
    const masked = { subject: mail.maskedSubject, body: mail.maskedHtml };

    let messageId: string;
    try {
      const info = (await this.transport.sendMail({
        from: { name: FROM_NAME, address: this.config.username },
        to,
        subject: mail.subject,
        html: mail.html,
      })) as { messageId: string };
      messageId = info.messageId;
    } catch (e) {
      const { code, responseCode } = e as {
        code?: string;
        responseCode?: number;
      };
      const reason = `code=${code} response=${responseCode}: ${(e as Error).message}`;
      // SMTP 응답에 받는 주소가 들어오기도 한다(550 … <HONG@example.com>). 대소문자나
      // 꺾쇠가 달라질 수 있어 주소 모양을 모두 가린다. 로그에서만 가리고, 이력에는
      // 같은 행에 to_email 이 있으니 원문을 둔다.
      this.logger.warn(
        `mail FAILED template=${templateCode} to=${maskEmail(to)} ${reason.replace(ADDRESS_IN_TEXT, maskEmail)}`,
      );
      await this.record(input, masked, reason);
      throw e;
    }

    this.logger.log(
      `mail ACCEPTED template=${templateCode} messageId=${messageId} to=${maskEmail(to)}`,
    );
    await this.record(input, masked, null);
    return { messageId };
  }

  /**
   * 이력 한 행. 실패해도 던지지 않는다 — 메일은 이미 나갔거나 SMTP 예외를 던질
   * 참이고, 여기서 던지면 호출부가 실패로 보고 다시 보낼 수 있다.
   */
  private async record(
    input: Omit<SendMailInput, 'variables' | 'maskedVariables'>,
    masked: { subject: string; body: string },
    failureReason: string | null,
  ): Promise<void> {
    try {
      await this.prisma.mailSendLog.create({
        data: {
          mailTypeCode: input.templateCode,
          adminAccountId: input.adminAccountId ?? null,
          fromEmail: this.config.username,
          toEmail: input.to,
          subject: masked.subject,
          body: masked.body,
          result: failureReason === null ? 'SUCCEEDED' : 'FAILED',
          failureReason,
          sentBy: input.sentBy ?? null,
        },
      });
    } catch (e) {
      // 메시지는 남기지 않는다. Prisma 오류 메시지는 호출 인자(data)를 통째로 찍어
      // 주소와 본문이 들어 있다. 이름·코드와 id 로 원인(P2003 이면 잘못 넘긴 id)을 가른다.
      const { name, code } = e as { name?: string; code?: string };
      this.logger.error(
        `mail_send_logs INSERT FAILED template=${input.templateCode} to=${maskEmail(input.to)} error=${name} code=${code} adminAccountId=${input.adminAccountId} sentBy=${input.sentBy}`,
      );
    }
  }
}

/** hong@example.com → h***@example.com */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}
