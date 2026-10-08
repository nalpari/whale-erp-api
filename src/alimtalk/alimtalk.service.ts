import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { findSendableTemplate } from '../notification-templates/find-template';
import {
  type TemplateVariable,
  renderTemplate,
} from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';

export type SendAlimtalkInput = {
  /** notification_templates.template_code. ALIMTALK 채널이어야 한다 */
  templateCode: string;
  /** 휴대폰 번호(01X…). 숫자가 아닌 글자는 모두 떼고 본다 — +82 형식은 받지 않는다 */
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** alimtalk_send_logs 에 ******** 로 남길 변수 — 초대 링크 등 */
  maskedVariables?: readonly string[];
  /**
   * 이 알림톡을 보내게 한 업무. 유형과 ID 를 한 객체로 받아 하나만 있는 상태를 막는다
   * (CHECK alimtalk_send_logs_related_pair).
   */
  related?: { type: string; id: number };
  /** 관리자가 대신 보냈을 때. 시스템이 보내면 비운다 */
  sentBy?: number;
};

export type AlimtalkSendResult = {
  /** 우리가 만든 요청 키. 비즈뿌리오 결과 리포트의 REFKEY 와 같다. */
  referenceKey: string;
  /** 비즈뿌리오가 붙인 메시지 키 */
  messageKey?: string;
};

const MOBILE = /^01\d{8,9}$/;
// 대체 문자: 이보다 길면 SMS 가 아니라 LMS 로 보낸다(비즈뿌리오 SMS 한도)
const SMS_MAX_BYTES = 90;
const LMS_SUBJECT = '[WHALE ERP]';
const LOG_REASON_LENGTH = 1000;

/**
 * 알림톡 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 문구는 `notification_templates` 의 ALIMTALK 템플릿이고, 비즈뿌리오에는 그 행의
 * `kakao_template_code` 로 보낸다. 본문은 카카오에 검수 등록한 문구와 글자 하나까지
 * 같아야 한다 — 다르면 비즈뿌리오가 거절한다.
 *
 * 접수(비즈뿌리오가 받음)까지만 책임진다. 실제 전달 결과는 비즈뿌리오 결과
 * 리포트로 오며 아직 받지 않는다. `/v3/message` 에서 code 없이 실패하면(네트워크 ·
 * 끊긴 응답) 접수됐을 수도 있으므로 다시 보내지 않는다. 실패는 던지므로, 발송이 본 작업을 막으면
 * 안 되는 곳은 호출부에서 잡는다. DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤
 * 부른다 — 롤백돼도 메시지는 이미 나간다.
 */
@Injectable()
export class AlimtalkService {
  private readonly logger = new Logger(AlimtalkService.name);

  constructor(
    private readonly client: BizppurioClient,
    @Inject(BIZPPURIO_CONFIG)
    private readonly config: Pick<
      BizppurioConfig,
      'account' | 'senderKey' | 'smsFrom'
    >,
    private readonly prisma: PrismaService,
  ) {}

  async send(input: SendAlimtalkInput): Promise<AlimtalkSendResult> {
    const { templateCode } = input;
    const phone = input.to.replace(/\D/g, '');
    if (!MOBILE.test(phone))
      throw new Error(`휴대폰 번호가 아닙니다: ${maskPhone(phone)}`);
    // 이력 INSERT 에서 거절될 값은 보내기 전에 막는다 — 보낸 뒤에는 이력만 조용히 빠진다.
    const { related, sentBy } = input;
    if (related && (related.type === '' || !isId(related.id)))
      throw new Error(
        `related 가 올바르지 않습니다: ${related.type}:${related.id}`,
      );
    if (sentBy !== undefined && !isId(sentBy))
      throw new Error(`sentBy 가 올바르지 않습니다: ${sentBy}`);

    const template = await findSendableTemplate(
      this.prisma,
      templateCode,
      'ALIMTALK',
    );
    // 본문은 로그에 남기지 않는다. 이름 · 초대 링크 같은 값이 들어간다.
    const { body, maskedBody } = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
    );

    // CHECK notification_templates_alimtalk_fields 가 ALIMTALK 행에 값을 보장한다.
    const kakaoTemplateCode = template.kakaoTemplateCode as string;
    // 이력에는 가린 본문만 넘긴다 — record 가 보낸 원문에 손댈 수 없게.
    const attempt = { input, phone, kakaoTemplateCode, maskedBody };
    const referenceKey = randomUUID().replace(/-/g, '').slice(0, 20);
    let messageKey: string | undefined;
    try {
      const response = await this.client.sendMessage({
        account: this.config.account,
        type: 'at',
        refkey: referenceKey,
        from: this.config.smsFrom,
        to: phone,
        content: {
          at: {
            senderkey: this.config.senderKey,
            templatecode: kakaoTemplateCode,
            message: body,
          },
        },
        ...smsFallback(withButtonLinks(body, template, input.variables)),
      });
      messageKey = response.messagekey;
    } catch (e) {
      const { code, httpStatus } =
        e instanceof BizppurioError ? e : ({} as BizppurioError);
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다. 로그 한 줄에는 메시지를
      // 1000자까지만 싣고, 이력에는 전부 둔다.
      const head = `code=${code} http=${httpStatus}`;
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `alimtalk FAILED template=${templateCode} referenceKey=${referenceKey} ${head} to=${maskPhone(phone)}: ${message.slice(0, LOG_REASON_LENGTH)}`,
      );
      await this.record(
        attempt,
        referenceKey,
        undefined,
        `${head}: ${message}`,
      );
      throw e;
    }

    this.logger.log(
      `alimtalk ACCEPTED template=${templateCode} referenceKey=${referenceKey} messageKey=${messageKey} to=${maskPhone(phone)}`,
    );
    await this.record(attempt, referenceKey, messageKey, null);
    return { referenceKey, messageKey };
  }

  /**
   * 이력 한 행. 실패해도 던지지 않는다 — 알림톡은 이미 접수됐거나 비즈뿌리오 예외를
   * 던질 참이고, 여기서 던지면 호출부가 실패로 보고 다시 보낼 수 있다.
   */
  private async record(
    attempt: {
      input: Omit<SendAlimtalkInput, 'variables' | 'maskedVariables'>;
      phone: string;
      kakaoTemplateCode: string;
      maskedBody: string;
    },
    referenceKey: string,
    messageKey: string | undefined,
    failureReason: string | null,
  ): Promise<void> {
    const { input, phone } = attempt;
    try {
      await this.prisma.alimtalkSendLog.create({
        data: {
          templateCode: input.templateCode,
          kakaoTemplateCode: attempt.kakaoTemplateCode,
          toPhone: phone,
          relatedType: input.related?.type ?? null,
          relatedId: input.related?.id ?? null,
          body: attempt.maskedBody,
          result: failureReason === null ? 'SUCCEEDED' : 'FAILED',
          failureReason,
          referenceKey,
          messageKey: messageKey ?? null,
          sentBy: input.sentBy ?? null,
        },
      });
    } catch (e) {
      // 메시지는 남기지 않는다. Prisma 오류 메시지는 호출 인자(data)를 통째로 찍어
      // 번호와 본문이 들어 있다. 이름 · 코드와 id 로 원인(P2003 이면 잘못 넘긴 sentBy)을 가른다.
      const { name, code } = (e ?? {}) as { name?: string; code?: string };
      const related = input.related
        ? `${input.related.type}:${input.related.id}`
        : undefined;
      this.logger.error(
        `alimtalk_send_logs INSERT FAILED template=${input.templateCode} referenceKey=${referenceKey} to=${maskPhone(phone)} error=${name} code=${code} related=${related} sentBy=${input.sentBy}`,
      );
    }
  }
}

/**
 * 알림톡이 실패하면(검수 안 된 템플릿, 카카오톡 미사용 등) 같은 본문을 문자로 보내게
 * 하는 대체 발송 지정. 길이에 따라 SMS 와 LMS 를 고른다. 대체 여부와 결과는 접수
 * 응답이 아니라 비즈뿌리오 결과 리포트에만 나온다.
 */
function smsFallback(
  message: string,
): Pick<BizppurioMessage, 'resend' | 'recontent'> {
  return eucKrBytes(message) <= SMS_MAX_BYTES
    ? { resend: { first: 'sms' }, recontent: { sms: { message } } }
    : {
        resend: { first: 'lms' },
        recontent: { lms: { subject: LMS_SUBJECT, message } },
      };
}

/**
 * 대체 문자에는 버튼이 없으므로 버튼 링크 변수(본문에 자리를 두지 않는다)의 값을 본문 끝에
 * 줄을 바꿔 붙인다. 그러지 않으면 「아래 링크로 …」 만 남고 링크가 없는 문자가 간다.
 */
function withButtonLinks(
  body: string,
  template: { variables: TemplateVariable[] },
  values: Record<string, string>,
): string {
  const links = template.variables
    .filter((v) => v.isButtonLink && Object.hasOwn(values, v.name))
    .map((v) => values[v.name])
    .filter((link) => link !== '');
  return [body, ...links].join('\n');
}

/**
 * 비즈뿌리오가 세는 EUC-KR 바이트 수. ASCII 는 1, 그 밖(한글 등)은 2 로 센다 —
 * EUC-KR 에 없는 글자(이모지 등)도 2 로 보므로 경계 근처에서는 어긋날 수 있다.
 */
function eucKrBytes(text: string): number {
  let bytes = 0;
  for (const c of text) bytes += c.charCodeAt(0) < 0x80 ? 1 : 2;
  return bytes;
}

/** integer 컬럼에 들어가는 id — 1..2147483647 */
function isId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/** 01012345678 → 010****5678 */
function maskPhone(phone: string): string {
  return phone.length < 8
    ? '***'
    : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
