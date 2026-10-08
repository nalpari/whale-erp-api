import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG, type MailConfig } from './mail.config';
import { findSendableTemplate } from '../notification-templates/find-template';
import { renderTemplate } from '../notification-templates/render-template';

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
// 자유 문장 속 주소 모양. 로그에서 가릴 때만 쓴다. 앵커가 없어 공백·구분 문자 없이
// 길게 이어진 토큰에서 시작 위치마다 끝까지 훑으므로(10만 자에 수 초) 가리기 전에
// LOG_REASON_LENGTH 로 자른다.
const ADDRESS_IN_TEXT = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;
const LOG_REASON_LENGTH = 1000;
// 주소 하나만 받는다. 쉼표·세미콜론이 있으면 nodemailer 가 받는 사람을 여럿으로
// 나누고, 꺾쇠·따옴표는 표시 이름으로 읽고, 콜론·괄호·역슬래시는 그룹·주석
// 문법이라 검사한 주소와 실제 받는 주소가 달라진다.
const EMAIL = /^[^\s@,;<>"():\\]+@[^\s@,;<>"():\\]+\.[^\s@,;<>"():\\]+$/;
// RFC 5321 경로 상한 256 에서 꺾쇠 둘을 뺀 값(UTF-16 글자 수로 센다). EMAIL 은
// 도메인 쪽 `.` 위치를 하나하나 다시 맞춰 보느라, 끝이 맞지 않는 입력에서 길이의
// 제곱만큼 일한다(10만 자에 수 초, 그동안 이벤트 루프가 멈춘다). 그래서 정규식보다
// 먼저 길이로 거부한다.
const MAX_EMAIL_LENGTH = 254;
// 버튼 링크는 웹 주소만 받는다. javascript: · data: 같은 스킴이 href 에 들어가지 않게.
const WEB_URL = /^https?:\/\//i;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 메일 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * `notification_templates` 의 EMAIL 템플릿을 채워 Gmail SMTP 로 보내고, 시도마다
 * `mail_send_logs` 에 한 행을 남긴다. 보내기 전 검증에 걸리면 보낸 것이 없으므로
 * 기록도 없다. 템플릿 본문은 일반 글이고(운영 정책 NTF-22), 머리 · 꼬리 · 버튼은
 * 여기 공통 틀이 붙인다 — 버튼은 버튼 링크 변수(isButtonLink)의 값이다.
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
    if (to.length > MAX_EMAIL_LENGTH || !EMAIL.test(to))
      throw new Error(`메일 주소가 아닙니다: ${maskEmail(to)}`);
    // 이력 INSERT 에서 거절될 값은 보내기 전에 막는다 — 보낸 뒤에는 이력만 조용히 빠진다.
    for (const name of ['adminAccountId', 'sentBy'] as const) {
      const id = input[name];
      if (id !== undefined && !isId(id))
        throw new Error(`${name} 가 올바르지 않습니다: ${id}`);
    }

    const template = await findSendableTemplate(
      this.prisma,
      templateCode,
      'EMAIL',
    );
    if (template.title === null)
      throw new Error(`메일 템플릿 ${templateCode} 에 제목이 없습니다`);

    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const mail = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
    );
    // 오류 메시지에 값은 담지 않는다 — 링크에는 토큰이 들어 있다.
    if (!mail.links.every((link) => WEB_URL.test(link)))
      throw new Error(
        `메일 템플릿 ${templateCode} 의 버튼 링크는 http(s) 주소여야 합니다`,
      );

    // 이력에는 가린 제목과 일반 글 본문만 넘긴다 — record 가 보낸 원문에 손댈 수 없게.
    // 위에서 title 이 null 이 아님을 확인했다.
    const masked = {
      subject: mail.maskedSubject as string,
      body: mail.maskedBody,
    };

    let messageId: string;
    try {
      const info = (await this.transport.sendMail({
        from: { name: FROM_NAME, address: this.config.username },
        to,
        subject: mail.subject as string,
        html: mailHtml(mail.body, mail.links),
        text: [mail.body, ...mail.links].join('\n\n'),
      })) as { messageId: string };
      messageId = info.messageId;
    } catch (e) {
      const { code, responseCode } = (e ?? {}) as {
        code?: string;
        responseCode?: number;
      };
      const message = e instanceof Error ? e.message : String(e);
      const reason = `code=${code} response=${responseCode}: ${message}`;
      // SMTP 응답에 받는 주소가 들어오기도 한다(550 … <HONG@example.com>). 대소문자나
      // 꺾쇠가 달라질 수 있어 주소 모양을 모두 가린다. 로그에서만 가리고, 이력에는
      // 같은 행에 to_email 이 있으니 원문을 둔다.
      this.logger.warn(
        `mail FAILED template=${templateCode} to=${maskEmail(to)} ${maskAddresses(reason)}`,
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
      const { name, code } = (e ?? {}) as { name?: string; code?: string };
      this.logger.error(
        `mail_send_logs INSERT FAILED template=${input.templateCode} to=${maskEmail(input.to)} error=${name} code=${code} adminAccountId=${input.adminAccountId} sentBy=${input.sentBy}`,
      );
    }
  }
}

/**
 * 공통 메일 틀. 일반 글 본문 전체(템플릿 글과 값)를 이스케이프하고 줄바꿈을 살려
 * 머리 · 꼬리 사이에 넣고, 링크마다 버튼을 붙인다. 스타일은 메일 클라이언트가
 * `<style>` 을 버리는 경우가 많아 인라인으로 둔다.
 */
function mailHtml(body: string, links: readonly string[]): string {
  const buttons = links
    .map(
      (link) =>
        `<p style="margin:24px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1f5eff;color:#ffffff;text-decoration:none;border-radius:6px">바로가기</a></p>`,
    )
    .join('');
  return [
    '<!doctype html><html lang="ko"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:sans-serif;color:#222222">',
    '<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px">',
    `<p style="margin:0 0 24px;font-size:18px;font-weight:bold">${FROM_NAME}</p>`,
    `<p style="margin:0;line-height:1.6">${escapeHtml(body).replace(/\r?\n/g, '<br>')}</p>`,
    buttons,
    '<p style="margin:32px 0 0;font-size:12px;color:#888888">이 메일은 발신 전용입니다.</p>',
    '</div></body></html>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * 로그에 남길 문장 속 주소를 가린다. 먼저 LOG_REASON_LENGTH 로 자르고, 잘렸으면
 * 끝에 걸친 단어를 버린다 — `<hong.gil` 처럼 반쪽 난 주소는 ADDRESS_IN_TEXT 에
 * 걸리지 않아 이름 부분이 그대로 남는다.
 */
function maskAddresses(text: string): string {
  const head =
    text.length > LOG_REASON_LENGTH
      ? text.slice(0, LOG_REASON_LENGTH).replace(/[^\s<>"'(),;:]*$/, '…')
      : text;
  return head.replace(ADDRESS_IN_TEXT, maskEmail);
}

/** integer 컬럼에 들어가는 id — 1..2147483647 */
function isId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/** hong@example.com → h***@example.com */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}
