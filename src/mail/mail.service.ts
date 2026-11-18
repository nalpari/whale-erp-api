import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG, type MailConfig } from './mail.config';
import { findSendableTemplate } from '../notification-templates/find-template';
import { isSendableEmail, MAX_EMAIL_LENGTH } from './mail-address';
import { renderTemplate } from '../notification-templates/render-template';
import { MAIL_LOGO_CID, MAIL_LOGO_PNG } from './mail-logo';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type SendMailInput = {
  /** notification_templates.template_code. EMAIL 채널이어야 한다 */
  templateCode: string;
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** mail_send_logs 에 ******** 로 남길 변수 — 임시 비밀번호 · 핀 등 */
  maskedVariables?: readonly string[];
  /** 수신 계정 id — 관리자 메일이면 admin_accounts, 직원 메일이면 accounts.account_id(mail_type_code 로 구분) */
  accountId?: number;
  /** 받는 사람이 직원일 때(직원 상세 발송 이력에 남는다). 직원 레코드가 지워지면 이력의 이 칸은 비워진다 */
  staffMemberId?: number;
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
// 받는 주소 규칙(SENDABLE_EMAIL · 길이 상한)은 DTO 도 같이 쓰도록 mail-address.ts 에 있다.
// 버튼 링크는 웹 주소만 받는다. javascript: · data: 같은 스킴이 href 에 들어가지 않게.
const WEB_URL = /^https?:\/\//i;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// SMTP 단계에서 다시 던진 예외. 던지는 타입은 그대로 두고(호출부가 기대하는 값 그대로) 표시만 남긴다.
const transportFailures = new WeakSet<object>();

/**
 * SMTP 서버와 주고받다 실패했는지. 보내기 전 검증(템플릿 없음 · 꺼짐, 주소 형식, 필수 변수)이나 DB 오류는
 * false 다 — 다시 시도해도 풀리지 않으니 호출부가 「잠시 후 다시」로 안내하지 않게.
 */
export function isMailTransportError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && transportFailures.has(e);
}

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
    let mail: Awaited<ReturnType<MailService['prepare']>>;
    try {
      mail = await this.prepare(input);
    } catch (e) {
      // 보내기 전에 막힌 것은 이력이 없어 이 줄이 유일한 단서다. 호출부는 주소가 섞일 수 있어 메시지를 남기지
      // 않으므로 여기서 남긴다 — 이 단계의 메시지에는 가린 주소 · 템플릿 코드 · 변수 이름만 들어간다.
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `mail NOT SENT template=${templateCode} to=${maskEmail(to.slice(0, MAX_EMAIL_LENGTH))}: ${maskAddresses(message)}`,
      );
      throw e;
    }

    // 이력에는 가린 제목과 일반 글 본문만 넘긴다 — record 가 보낸 원문에 손댈 수 없게.
    // prepare 에서 title 이 null 이 아님을 확인했다.
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
        // 블록 모양은 채우기 전 템플릿 본문으로 정한다 — 값 안의 줄바꿈이 표 · 안내를 꾸미지 못하게
        html: mailHtml(
          mail.subject as string,
          mail.templateBody,
          mail.links,
          fillLine(input.variables),
        ),
        text: [mail.body, ...mail.links].join('\n\n'),
        // 띠의 고래 로고 — 공개 주소 없이 보이게 인라인 첨부(cid)로 싣는다
        attachments: [
          {
            filename: 'whale-erp.png',
            content: MAIL_LOGO_PNG,
            contentType: 'image/png',
            cid: MAIL_LOGO_CID,
            contentDisposition: 'inline',
          },
        ],
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
      // 이력보다 먼저 표시한다 — record 가 던지지 않는다는 약속에 기대지 않게.
      if (typeof e === 'object' && e !== null)
        transportFailures.add(e as object);
      await this.record(input, masked, reason);
      throw e;
    }

    this.logger.log(
      `mail ACCEPTED template=${templateCode} messageId=${messageId} to=${maskEmail(to)}`,
    );
    await this.record(input, masked, null);
    return { messageId };
  }

  /** 보내기 전 검증과 렌더링. 던지면 보낸 것도 이력도 없다. */
  private async prepare(input: SendMailInput) {
    const { templateCode, to } = input;
    if (!isSendableEmail(to))
      throw new Error(`메일 주소가 아닙니다: ${maskEmail(to)}`);
    // 이력 INSERT 에서 거절될 값은 보내기 전에 막는다 — 보낸 뒤에는 이력만 조용히 빠진다.
    for (const name of ['accountId', 'staffMemberId', 'sentBy'] as const) {
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

    return { ...mail, templateBody: template.body };
  }

  /**
   * 이력 한 행. 실패해도 던지지 않는다 — 메일은 이미 나갔거나 SMTP 예외를 던질
   * 참이고, 여기서 던지면 호출부가 실패로 보고 다시 보낼 수 있다. 이력이 빠지면
   * 직원 상세 발송 이력에서도 빠진다. 직원 레코드가 그 사이 지워져 FK 위반(P2003)이면
   * 직원 칸을 비워 한 번 더 남긴다(지워진 뒤의 SET NULL 상태와 같다). 위반한 제약이 직원 FK 가 아님이
   * 확인되면(sent_by 등) 다시 남기지 않는다.
   */
  private async record(
    input: Omit<SendMailInput, 'variables' | 'maskedVariables'>,
    masked: { subject: string; body: string },
    failureReason: string | null,
  ): Promise<void> {
    const data = {
      mailTypeCode: input.templateCode,
      accountId: input.accountId ?? null,
      staffMemberId: input.staffMemberId ?? null,
      fromEmail: this.config.username,
      toEmail: input.to,
      subject: masked.subject,
      body: masked.body,
      result:
        failureReason === null ? ('SUCCEEDED' as const) : ('FAILED' as const),
      failureReason,
      sentBy: input.sentBy ?? null,
    };
    try {
      try {
        await this.prisma.mailSendLog.create({ data });
      } catch (e) {
        if (data.staffMemberId === null || !isStaffMemberFkViolation(e))
          throw e;
        await this.prisma.mailSendLog.create({
          data: { ...data, staffMemberId: null },
        });
      }
    } catch (e) {
      // 메시지는 남기지 않는다. Prisma 오류 메시지는 호출 인자(data)를 통째로 찍어
      // 주소와 본문이 들어 있다. 이름·코드와 id 로 원인(P2003 이면 잘못 넘긴 id)을 가른다.
      const { name, code } = (e ?? {}) as { name?: string; code?: string };
      this.logger.error(
        `mail_send_logs INSERT FAILED template=${input.templateCode} to=${maskEmail(input.to)} error=${name} code=${code} accountId=${input.accountId} staffMemberId=${input.staffMemberId} sentBy=${input.sentBy}`,
      );
    }
  }
}

/**
 * 메일 꼬리의 운영사 정보 — 쿠팡 메일 꼬리처럼 「상호」 이름표 없이 회사명부터(2026-11-18 사용자 지정, 대표이사 이정선).
 * 주소 · 전화 · 사업자등록번호는 로그인 전 홈 꼬리(front guest-footer)와 같은 값(2026-10-22 재영).
 */
/** 띠의 「WHALE ERP」 옆에 가운뎃점으로 이어 작게 붙이는 서비스 설명(2026-11-18 사용자 지정 — 한 번 뺐다가 점을 두고 다시 넣었다) */
const SERVICE_TAGLINE = '매장 통합관리 서비스';

// 꼬리 한 줄 안 항목 사이 구분자 — 작고 옅은 「|」(글자보다 작게 · 연한 회색), 정신없지 않게(2026-11-18 사용자 지정)
const GAP = '<span style="margin:0 8px;font-size:10px;color:#c9cdd3">|</span>';
const FOOTER_HTML = [
  '본 메일은 발신전용으로 회신되지 않습니다.',
  '',
  // 점 · 콜론은 쓰지 않고 작은 「|」 하나로만 가른다 — 점 · 콜론이 섞여 복잡해 보였다(2026-11-18 사용자 지정)
  ['(주)인터플러그', '대표이사 이정선', '사업자등록번호 105-87-63602'].join(
    GAP,
  ),
  [
    '03787 서울특별시 서대문구 연세로 5다길 22-3, 발리빌딩 3층',
    '전화 02-6928-0028',
  ].join(GAP),
  // 로그인 전 홈 꼬리와 같은 저작권 줄(2026-11-18 사용자 지정)
  'Copyrights© 2026 INTERPLUG. All Rights Reserved.',
].join('<br>');
// 본문 블록 — 「- 항목: 값」 줄은 정보 표, 「※」 줄은 안내 상자, 나머지는 문단.
// 콜론 뒤에 빈칸이 있어야 표다 — 「- 10:00 이후」 · 「- https://…」 는 문단으로 둔다.
const INFO_LINE = /^\s*-\s*([^:\n]{1,30}?)\s*:\s+(.+)$/;
const NOTICE_LINE = /^\s*※\s*(.*)$/;
type BodyBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'info'; rows: [string, string][] }
  | { kind: 'notice'; lines: string[] };

const lines = (text: string) => text.split(/\r?\n/);

/**
 * 본문을 블록으로 나눈다. 빈 줄은 문단 사이 간격으로만 쓰고 버린다.
 *
 * 모양(표 · 안내 · 문단)은 **값을 채우기 전 템플릿 줄**로 정하고, 값은 그 뒤에 `fill` 로 채운다. 채운 본문으로 정하면
 * 값 안의 줄바꿈이 새 표 줄 · 안내 상자를 만들어, 로그인 없이 넣는 상호명 같은 값이 공식 안내처럼 보이게 꾸밀 수 있었다
 * (PR #296 리뷰). 값 안의 줄바꿈은 그 문단 · 안내 안의 줄바꿈으로만 남고, 표 값에서는 빈칸이 된다.
 * 문장마다 줄바꿈(`sentences`)도 템플릿 글에만 건다 — 운영자 답변 · 상호명 같은 값 안의 「1. 」 · 「Co. Ltd」 는 나누지 않는다.
 */
export function bodyBlocks(
  template: string,
  fill: (text: string) => string = (text) => text,
): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  // 템플릿 글을 문장마다 나눈 뒤 값을 채우고, 값 안의 줄바꿈은 그 자리의 줄바꿈으로 둔다
  const filled = (text: string) =>
    sentences(text).flatMap((s) => lines(fill(s)));
  for (const line of joinBrokenLines(lines(template))) {
    const last = blocks.at(-1);
    if (!line.trim()) {
      if (last?.kind === 'text') blocks.push({ kind: 'text', lines: [] });
      continue;
    }
    const info = INFO_LINE.exec(line);
    const notice = NOTICE_LINE.exec(line);
    if (info) {
      const row: [string, string] = [
        fill(info[1]).replace(/\s*\r?\n\s*/g, ' '),
        fill(info[2]).replace(/\s*\r?\n\s*/g, ' '),
      ];
      if (last?.kind === 'info') last.rows.push(row);
      else blocks.push({ kind: 'info', rows: [row] });
    } else if (notice) {
      if (last?.kind === 'notice') last.lines.push(...filled(notice[1]));
      else blocks.push({ kind: 'notice', lines: filled(notice[1]) });
    } else if (last?.kind === 'text') last.lines.push(...filled(line));
    else blocks.push({ kind: 'text', lines: filled(line) });
  }
  return blocks
    .map((b) =>
      b.kind === 'info' ? b : { ...b, lines: b.lines.filter((l) => l.trim()) },
    )
    .filter((b) => b.kind === 'info' || b.lines.length);
}

/**
 * 문장 가운데서 끊은 템플릿 줄을 한 줄로 잇는다 — 「필요하면 계약 조건을 수정해 / 근로계약서를 다시 보내 주세요.」처럼
 * 템플릿이 글자 수에 맞춰 줄을 바꿔 둔 것이 메일에서 어색하게 끊겨 보였다(2026-11-18 사용자 지정). 문장 끝(. ? !)으로
 * 끝나지 않은 일반 줄 뒤에 일반 줄이 바로 오면 빈칸 하나로 잇는다. 빈 줄 · 「- 」로 시작하는 줄(표 · 목록) · 「※」 줄은 잇지 않는다.
 */
export function joinBrokenLines(source: string[]): string[] {
  // 「- 」 목록 줄도 잇지 않는다(표가 아닌 목록 · 시각 줄)
  const plain = (line: string) =>
    !!line.trim() && !/^\s*-/.test(line) && !NOTICE_LINE.test(line);
  const out: string[] = [];
  for (const line of source) {
    const prev = out.at(-1);
    if (
      prev !== undefined &&
      plain(prev) &&
      plain(line) &&
      !/[.?!][)"'」』]?\s*$/.test(prev)
    )
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

/** 템플릿 한 줄의 `#{변수}` 를 채운다 — renderTemplate 이 이미 이름 · 필수 값을 검사한 뒤에만 쓴다 */
export function fillLine(values: Record<string, string>) {
  return (text: string) =>
    text.replace(/#\{([^}]+)\}/g, (_, name: string) =>
      Object.hasOwn(values, name) && typeof values[name] === 'string'
        ? values[name]
        : '',
    );
}

/**
 * 한 줄을 문장마다 나눈다(2026-11-18 사용자 지정 — 메일 글은 문장마다 줄을 바꾼다). 문장 끝(. ? !) 뒤에 빈칸이 올 때만
 * 나눠 3.3% · 1.5배 · URL 같은 값은 그대로 둔다. 따옴표 · 괄호로 닫힌 문장 끝도 나눈다.
 */
export function sentences(line: string): string[] {
  return line
    .split(/(?<=[.?!][)"'」』]?)\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 메일 제목 앞의 「[WHALE ERP]」를 떼어 본문 머리 제목으로 쓴다 */
export function mailHeading(subject: string): string {
  return subject.replace(/^\s*\[\s*WHALE\s*ERP\s*\]\s*/i, '').trim() || subject;
}

/**
 * 공통 메일 틀(2026-11-18 사용자 지정 「C 커머스 안내형」 — 쿠팡 · 마켓컬리 · SSG 주문 안내 메일의 짜임, 보낸 곳이 분명하게 · 신뢰도).
 * 흰 바탕 한 장에 왼쪽 위 고래 로고 · 「WHALE ERP · 매장 통합관리 서비스」, 크게 굵은 제목(메일 제목에서 [WHALE ERP] 를 뗀 것),
 * 본문 블록(문단 · 「- 항목: 값」 회색 둥근 정보 상자 · 「※」 회색 안내 글), 폭을 채우는 버튼, 굵은 회색 구분 띠,
 * 꼬리(발신전용 안내 · 한 줄 띄고 운영사 정보 · 저작권). 템플릿은 고치지 않는다. 본문 · 제목 · 값은 모두 이스케이프하고,
 * 스타일은 `<style>` 을 버리는 메일 화면이 많아 인라인으로 둔다.
 *
 * 카드는 표(table)로 왼쪽에 붙이고 칸과 글마다 왼쪽 정렬을 적는다. 정렬을 적지 않으면 네이버 · 다음 · Outlook 처럼
 * 받은 메일을 가운데 정렬 칸에 넣어 보여 주는 메일 화면에서 본문이 가운데로 물려받아 보였다(2026-11-13 사용자 지적).
 * 카드 자리도 바깥 칸 · Outlook 전용 표에 align="left" 를 적어 왼쪽에 둔다(2026-11-18 사용자 지정, 통합테스트).
 * 카드 폭은 `width:100%;max-width:560px` 라 좁은 화면에서는 줄어들고, `max-width` 를 모르는 Outlook 데스크톱(Word 엔진)은
 * 그 전용 주석(`<!--[if mso]>`) 안의 560px 표가 폭을 잡는다. 글꼴 · 색은 body 스타일을 버리는 메일 화면이 많아 칸마다 다시 적는다.
 * 바탕 · 상자 · 버튼 색은 bgcolor 와 style 에 함께 적는다 — 다크 모드 메일 앱이 style 색만 뒤집는 경우가 있다.
 * 로고 그림과 글자는 표의 두 칸에 나눠 valign="middle" 로 세로 가운데를 맞춘다 — 글자 줄의 vertical-align 은 메일 화면마다
 * 어긋났다(2026-11-18 사용자 지정). 로고는 send 가 인라인 첨부(cid, mail-logo.ts)로 싣는 PNG 다.
 */
export function mailHtml(
  subject: string,
  /** 값을 채우기 전 템플릿 본문 — 블록 모양은 이것으로 정한다(bodyBlocks) */
  body: string,
  links: readonly string[],
  fill?: (text: string) => string,
): string {
  const L = 'text-align:left';
  const FONT = "font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const INK = '#3c4046';
  // 본문 글(문단 · 안내 · 정보 상자)은 모두 15px 하나로 — 크기가 섞여 어색했다(2026-11-18 사용자 지정). 안내는 색만 옅게
  const TABLE =
    'role="presentation" cellpadding="0" cellspacing="0" border="0"';
  const header =
    `<table ${TABLE}><tr>` +
    `<td width="34" valign="middle" style="width:34px;vertical-align:middle;padding:0 10px 0 0"><img src="cid:${MAIL_LOGO_CID}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0"></td>` +
    `<td valign="middle" style="vertical-align:middle;${L};${FONT};white-space:nowrap"><span style="font-size:17px;font-weight:800;color:#0c0c0c;letter-spacing:0.02em">${FROM_NAME}</span><span style="margin:0 7px;font-size:12px;color:#b9bec5">·</span><span style="font-size:12px;color:#8a8f96">${SERVICE_TAGLINE}</span></td>` +
    '</tr></table>';
  const block = (b: BodyBlock): string => {
    if (b.kind === 'text')
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#555b63;${L}">${b.lines.map(escapeHtml).join('<br>')}</p>`;
    if (b.kind === 'notice')
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#8a8f96;${L}">${b.lines.map(escapeHtml).join('<br>')}</p>`;
    const rows = b.rows
      .map(
        ([k, v], i) =>
          `<tr><td width="120" valign="top" style="width:120px;padding:14px 0;color:#8a8f96;font-size:15px;${i ? 'border-top:1px solid #e9ebef;' : ''}${L}">${escapeHtml(k)}</td><td valign="top" style="padding:14px 0 14px 12px;color:#111111;font-size:15px;font-weight:bold;word-break:break-all;${i ? 'border-top:1px solid #e9ebef;' : ''}${L}">${escapeHtml(v)}</td></tr>`,
      )
      .join('');
    return `<table ${TABLE} width="100%" style="margin:6px 0 22px"><tr><td bgcolor="#f6f7f9" style="padding:6px 22px;background:#f6f7f9;border-radius:10px"><table ${TABLE} width="100%" style="border-collapse:collapse">${rows}</table></td></tr></table>`;
  };
  const buttons = links
    .map(
      (link) =>
        `<table ${TABLE} width="100%" style="margin:8px 0 6px"><tr><td align="center" bgcolor="#ffffff" style="text-align:center;padding:15px 24px;border:1px solid #6b7988;border-radius:8px;background:#ffffff"><a href="${escapeHtml(link)}" style="display:inline-block;color:#3c4046;font-size:15px;font-weight:bold;text-decoration:none">바로가기</a></td></tr></table>`,
    )
    .join('');
  return [
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;padding:0;background:#ffffff;${FONT};color:${INK}">`,
    `<table ${TABLE} width="100%" bgcolor="#ffffff" style="background:#ffffff"><tr><td align="left" style="padding:0;${L}">`,
    '<!--[if mso]><table role="presentation" width="560" align="left" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table ${TABLE} width="560" bgcolor="#ffffff" style="width:100%;max-width:560px;background:#ffffff">`,
    // 머리 영역 아래 옅은 구분선 — 머리와 본문을 가른다(2026-11-18 사용자 지정)
    `<tr><td align="left" style="padding:28px 32px 22px;border-bottom:1px solid #e6e8eb;${L}">${header}</td></tr>`,
    `<tr><td align="left" style="padding:28px 32px 28px;${L};${FONT};color:${INK}">`,
    `<p style="margin:0 0 14px;font-size:22px;line-height:1.4;font-weight:bold;color:#111111;${L}">${escapeHtml(mailHeading(subject))}</p>`,
    bodyBlocks(body, fill).map(block).join(''),
    buttons,
    '</td></tr>',
    // 굵은 회색 구분 띠 — 본문과 꼬리를 가른다
    '<tr><td bgcolor="#f2f3f5" height="8" style="height:8px;line-height:8px;font-size:0;background:#f2f3f5">&nbsp;</td></tr>',
    `<tr><td align="left" style="padding:22px 32px 32px;font-size:12px;line-height:1.8;color:#8a8f96;${L};${FONT}">${FOOTER_HTML}</td></tr>`,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table></body></html>',
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

const STAFF_MEMBER_FK = 'mail_send_logs_staff_member_id_fkey';

/**
 * P2003 이면서 직원 FK 위반인가. 어느 제약인지는 Prisma 7 어댑터 오류의
 * `meta.driverAdapterError.cause.constraint.index` 에서 읽는다. 제약 이름을 읽을 수 없으면(모양이 달라졌을 때)
 * 직원 FK 로 보고 한 번 다시 남긴다 — 어차피 한 번뿐이고 실패하면 로그가 남는다.
 */
function isStaffMemberFkViolation(e: unknown): boolean {
  const err = e as
    | {
        code?: string;
        meta?: {
          driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
        };
      }
    | undefined;
  if (err?.code !== 'P2003') return false;
  const constraint = err.meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof constraint !== 'string' || constraint === STAFF_MEMBER_FK;
}
