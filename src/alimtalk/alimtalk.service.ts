import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { findSendableTemplate } from '../notification-templates/find-template';
import { renderTemplate } from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AlimtalkButton,
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';
import { failureHeadOf } from './failure-reason';

export type SendAlimtalkInput = {
  /** notification_templates.template_code. ALIMTALK 채널이어야 한다 */
  templateCode: string;
  /** 휴대폰 번호(01X…). 숫자가 아닌 글자는 모두 떼고 본다 — +82 형식은 받지 않는다 */
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** alimtalk_send_logs 에 ******** 로 남길 변수 — 초대 코드 · 재설정 링크 등 */
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
/** 알림톡을 보낼 수 있는 휴대폰 번호인가(숫자만 보고 판단). 호출부가 쓰기 전에 거를 때 쓴다 */
export const isMobilePhone = (phone: string) =>
  MOBILE.test(phone.replace(/\D/g, ''));
// 대체 문자: 이보다 길면 SMS 가 아니라 LMS 로 보낸다(비즈뿌리오 SMS 한도)
const SMS_MAX_BYTES = 90;
const LMS_SUBJECT = '[WHALE ERP]';
const LOG_REASON_LENGTH = 1000;
// 버튼 링크는 웹 주소만 싣는다(메일 버튼과 같다)
const WEB_URL = /^https?:\/\//i;

/**
 * 버튼 링크 변수(isButtonLink)가 있는 알림톡 템플릿의 버튼 이름(WHALEERP-636). 카카오에 등록 · 검수한 버튼 이름과 글자
 * 하나까지 같아야 한다 — 다르면 비즈뿌리오가 거절한다(28자까지). 템플릿 변수 목록이 아니라 코드에 두는 까닭: 변수 목록은
 * 템플릿 관리 화면이 저장할 때 아는 칸만 남겨, 거기에 둔 이름은 화면에서 한 번 저장하면 지워진다(메일 버튼 「바로가기」도
 * 코드에 있다). 템플릿 코드로 찾는다 — 발송 코드가 템플릿을 부르는 이름이다. 두 이름은 재영 2026-10-30 확정, 카카오에도
 * 이 이름으로 등록한다 — 바꾸면 카카오 재검수와 함께 바꾼다.
 */
export const ALIMTALK_BUTTON_NAMES: Readonly<Record<string, string>> = {
  TALK_STAFF_INVITATION: '가입하기',
  TALK_STAFF_AFFILIATION_REQUEST: '요청 확인하기',
};

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

  /**
   * 알림톡이 실패했을 때 문자로 대신 보내는가(BIZPPURIO_SMS_FROM 이 있는가). 버튼 링크는 알림톡 버튼과 대체 문자 끝에
   * 함께 실린다. 카카오가 아직 검수하지 않은 템플릿(본문 · 버튼이 등록과 다름)은 알림톡이 거절되고 대체 문자로만 닿으므로,
   * 링크가 꼭 가야 하는 호출부는 보내기 전에 확인한다.
   */
  hasSmsFallback(): boolean {
    return this.config.smsFrom !== null;
  }

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
    // 본문은 로그에 남기지 않는다. 이름 · 초대 코드 같은 값이 들어간다.
    const { body, maskedBody, links } = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
    );
    const button = buttonsOf(templateCode, links);

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
        to: phone,
        content: {
          at: {
            senderkey: this.config.senderKey,
            templatecode: kakaoTemplateCode,
            message: body,
            ...(button.length ? { button } : {}),
          },
        },
        // 문자에는 버튼이 없어 버튼 링크를 본문 끝에 줄을 바꿔 붙인다. 그러지 않으면
        // 「아래 링크로 …」 만 남고 링크가 없는 문자가 간다. 발신번호가 없으면 대체하지 않는다.
        ...(this.config.smsFrom === null
          ? {}
          : smsFallback(this.config.smsFrom, [body, ...links].join('\n'))),
      });
      messageKey = response.messagekey;
    } catch (e) {
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다. 로그 한 줄에는 메시지를
      // 1000자까지만 싣고, 이력에는 전부 둔다. 머리 형식은 failure-reason.ts(근로계약 발송 이력이 되읽는다).
      const head = failureHeadOf(e instanceof BizppurioError ? e : null);
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
 * 버튼 링크 값을 웹링크(WL) 버튼 하나로. PC 카카오톡에도 보이게 모바일 · PC 링크를 같은 값으로 싣는다(직원 근무 앱은
 * 모바일 웹이라 PC 브라우저에서도 열린다, 재영 2026-10-30). 이름이 정해지지 않은 템플릿, 웹 주소가 아닌 링크, 버튼 링크
 * 변수가 둘 이상인 템플릿(한 이름의 버튼만 등록한다)은 보내기 전에 던진다 — 오류 메시지에 링크(토큰)는 담지 않는다.
 * 링크가 없으면(선택 변수를 비움) 버튼도 없다 — 버튼을 등록한 템플릿이면 알림톡은 거절되고 대체 문자로 간다.
 */
function buttonsOf(
  templateCode: string,
  links: readonly string[],
): AlimtalkButton[] {
  if (!links.length) return [];
  const name = Object.hasOwn(ALIMTALK_BUTTON_NAMES, templateCode)
    ? ALIMTALK_BUTTON_NAMES[templateCode]
    : undefined;
  if (!name)
    throw new Error(`알림톡 템플릿 ${templateCode} 의 버튼 이름이 없습니다`);
  if (links.length > 1)
    throw new Error(
      `알림톡 템플릿 ${templateCode} 의 버튼 링크는 하나만 쓸 수 있습니다`,
    );
  if (!links.every((link) => WEB_URL.test(link)))
    throw new Error(
      `알림톡 템플릿 ${templateCode} 의 버튼 링크는 http(s) 주소여야 합니다`,
    );
  return links.map((link) => ({
    name,
    type: 'WL',
    url_mobile: link,
    url_pc: link,
  }));
}

/**
 * 알림톡이 실패하면(검수 안 된 템플릿, 카카오톡 미사용 등) 같은 본문을 문자로 보내게
 * 하는 대체 발송 지정. 길이에 따라 SMS 와 LMS 를 고른다. 대체 여부와 결과는 접수
 * 응답이 아니라 비즈뿌리오 결과 리포트에만 나온다.
 */
function smsFallback(
  from: string,
  message: string,
): Pick<BizppurioMessage, 'from' | 'resend' | 'recontent'> {
  return eucKrBytes(message) <= SMS_MAX_BYTES
    ? { from, resend: { first: 'sms' }, recontent: { sms: { message } } }
    : {
        from,
        resend: { first: 'lms' },
        recontent: { lms: { subject: LMS_SUBJECT, message } },
      };
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
