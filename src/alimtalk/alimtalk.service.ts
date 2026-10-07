import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ALIMTALK_TEMPLATE_REGISTRY,
  type AlimtalkTemplate,
  type AlimtalkTemplateCode,
  type AlimtalkVariables,
} from './alimtalk-templates';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';

export type AlimtalkSendResult = {
  /** 우리가 만든 요청 키. 비즈뿌리오 결과 리포트의 REFKEY 와 같다. */
  refKey: string;
  /** 비즈뿌리오가 붙인 메시지 키 */
  messageKey?: string;
};

const PLACEHOLDER = /#\{([^}]+)\}/g;
const MOBILE = /^01\d{8,9}$/;

/**
 * 알림톡 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 접수(비즈뿌리오가 받음)까지만 책임진다. 실제 전달 결과는 비즈뿌리오 결과
 * 리포트로 오며 아직 받지 않는다. 실패는 던지므로, 발송이 본 작업을 막으면
 * 안 되는 곳(best-effort)은 호출부에서 잡는다. DB 트랜잭션과 함께 쓸 때는
 * 커밋이 끝난 뒤 부른다 — 트랜잭션 안에서 보내면 롤백돼도 메시지는 이미 나간다.
 */
@Injectable()
export class AlimtalkService {
  private readonly logger = new Logger(AlimtalkService.name);

  constructor(
    private readonly client: BizppurioClient,
    @Inject(BIZPPURIO_CONFIG)
    private readonly config: Pick<BizppurioConfig, 'account' | 'senderKey'>,
    @Inject(ALIMTALK_TEMPLATE_REGISTRY)
    private readonly templates: Record<string, AlimtalkTemplate>,
  ) {}

  async send<C extends AlimtalkTemplateCode>(
    code: C,
    to: string,
    variables: AlimtalkVariables<C>,
  ): Promise<AlimtalkSendResult> {
    // 레지스트리가 비면 C 가 never 로 좁혀지므로 문자열로 다뤄 둔다.
    const templateCode: string = code;
    const template = this.templates[templateCode];
    if (!template)
      throw new Error(`알림톡 템플릿 ${templateCode} 이(가) 없습니다`);
    const phone = to.replace(/\D/g, '');
    if (!MOBILE.test(phone))
      throw new Error(`휴대폰 번호가 아닙니다: ${maskPhone(phone)}`);
    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const message = render(template.body, variables, templateCode);
    const title =
      template.title && render(template.title, variables, templateCode);

    const refKey = randomUUID().replace(/-/g, '').slice(0, 20);
    const at: BizppurioMessage['content']['at'] = {
      senderkey: this.config.senderKey,
      templatecode: templateCode,
      message,
    };
    if (title) at.title = title;

    try {
      const response = await this.client.sendMessage({
        account: this.config.account,
        type: 'at',
        refkey: refKey,
        to: phone,
        content: { at },
      });
      this.logger.log(
        `alimtalk ACCEPTED template=${templateCode} refKey=${refKey} messageKey=${response.messagekey} to=${maskPhone(phone)}`,
      );
      return { refKey, messageKey: response.messagekey };
    } catch (e) {
      const { code: bizCode, httpStatus } =
        e instanceof BizppurioError ? e : ({} as BizppurioError);
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
      this.logger.warn(
        `alimtalk FAILED template=${templateCode} refKey=${refKey} code=${bizCode} http=${httpStatus} to=${maskPhone(phone)}: ${(e as Error).message}`,
      );
      throw e;
    }
  }
}

/**
 * `#{변수}` 를 한 번에 치환한다. 값 안의 `#{...}` 는 다시 치환하지 않는다.
 * 값이 문자열이 아닌 변수(빠졌거나 null)가 있으면 `#{변수}` 가 글자 그대로
 * 나가지 않도록 보내기 전에 던진다. 빈 문자열은 값으로 보고 그대로 치환한다.
 */
function render(
  body: string,
  variables: Record<string, string>,
  code: string,
): string {
  const missing = new Set<string>();
  const message = body.replace(PLACEHOLDER, (match, name: string) => {
    // 자기 키만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게.
    const value: unknown = Object.hasOwn(variables, name)
      ? variables[name]
      : undefined;
    if (typeof value === 'string') return value;
    missing.add(name);
    return match;
  });
  if (missing.size)
    throw new Error(
      `알림톡 ${code} 변수가 비었습니다: ${[...missing].join(', ')}`,
    );
  return message;
}

/** 01012345678 → 010****5678 */
function maskPhone(phone: string): string {
  return phone.length < 8
    ? '***'
    : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
