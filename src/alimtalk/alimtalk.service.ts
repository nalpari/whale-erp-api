import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { findSendableTemplate } from '../notification-templates/find-template';
import { renderTemplate } from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import { BizppurioClient, BizppurioError } from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';

export type SendAlimtalkInput = {
  /** notification_templates.template_code. ALIMTALK 채널이어야 한다 */
  templateCode: string;
  /** 휴대폰 번호. 하이픈 · 공백은 떼고 본다 */
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /**
   * 발송 이력에서 ******** 로 남길 변수 — 초대 링크 등. 이력 테이블이 생기기 전인
   * 지금은 템플릿에 있는 이름인지만 검사한다.
   */
  maskedVariables?: readonly string[];
};

export type AlimtalkSendResult = {
  /** 우리가 만든 요청 키. 비즈뿌리오 결과 리포트의 REFKEY 와 같다. */
  refKey: string;
  /** 비즈뿌리오가 붙인 메시지 키 */
  messageKey?: string;
};

const MOBILE = /^01\d{8,9}$/;
const LOG_REASON_LENGTH = 1000;

/**
 * 알림톡 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 문구는 `notification_templates` 의 ALIMTALK 템플릿이고, 비즈뿌리오에는 그 행의
 * `kakao_template_code` 로 보낸다. 본문은 카카오에 검수 등록한 문구와 글자 하나까지
 * 같아야 한다 — 다르면 비즈뿌리오가 거절한다.
 *
 * 접수(비즈뿌리오가 받음)까지만 책임진다. 실제 전달 결과는 비즈뿌리오 결과
 * 리포트로 오며 아직 받지 않는다. code 없는 오류(네트워크 · 끊긴 응답)는 「안
 * 갔다」가 아니므로 다시 보내지 않는다. 실패는 던지므로, 발송이 본 작업을 막으면
 * 안 되는 곳은 호출부에서 잡는다. DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤
 * 부른다 — 롤백돼도 메시지는 이미 나간다.
 */
@Injectable()
export class AlimtalkService {
  private readonly logger = new Logger(AlimtalkService.name);

  constructor(
    private readonly client: BizppurioClient,
    @Inject(BIZPPURIO_CONFIG)
    private readonly config: Pick<BizppurioConfig, 'account' | 'senderKey'>,
    private readonly prisma: PrismaService,
  ) {}

  async send(input: SendAlimtalkInput): Promise<AlimtalkSendResult> {
    const { templateCode } = input;
    const phone = input.to.replace(/\D/g, '');
    if (!MOBILE.test(phone))
      throw new Error(`휴대폰 번호가 아닙니다: ${maskPhone(phone)}`);

    const template = await findSendableTemplate(
      this.prisma,
      templateCode,
      'ALIMTALK',
    );
    // 본문은 로그에 남기지 않는다. 이름 · 초대 링크 같은 값이 들어간다.
    const { body } = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
    );

    const refKey = randomUUID().replace(/-/g, '').slice(0, 20);
    try {
      const response = await this.client.sendMessage({
        account: this.config.account,
        type: 'at',
        refkey: refKey,
        to: phone,
        content: {
          at: {
            senderkey: this.config.senderKey,
            // CHECK notification_templates_alimtalk_fields 가 ALIMTALK 행에 값을 보장한다.
            templatecode: template.kakaoTemplateCode as string,
            message: body,
          },
        },
      });
      this.logger.log(
        `alimtalk ACCEPTED template=${templateCode} refKey=${refKey} messageKey=${response.messagekey} to=${maskPhone(phone)}`,
      );
      return { refKey, messageKey: response.messagekey };
    } catch (e) {
      const { code, httpStatus } =
        e instanceof BizppurioError ? e : ({} as BizppurioError);
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
      this.logger.warn(
        `alimtalk FAILED template=${templateCode} refKey=${refKey} code=${code} http=${httpStatus} to=${maskPhone(phone)}: ${(e as Error).message.slice(0, LOG_REASON_LENGTH)}`,
      );
      throw e;
    }
  }
}

/** 01012345678 → 010****5678 */
function maskPhone(phone: string): string {
  return phone.length < 8
    ? '***'
    : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
