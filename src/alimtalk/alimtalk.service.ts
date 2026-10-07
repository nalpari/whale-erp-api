import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';

export type AlimtalkSendResult = {
  /** 우리가 만든 요청 키. 비즈뿌리오 결과 리포트의 REFKEY 와 같다. */
  refKey: string;
  /** 비즈뿌리오가 붙인 메시지 키 */
  messageKey?: string;
};

const MOBILE = /^01\d{8,9}$/;

/**
 * 알림톡 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 문구는 `notification_templates` 의 ALIMTALK 템플릿이고, 비즈뿌리오에는 그 행의
 * `kakao_template_code` 로 보낸다. 본문이 카카오 검수 문구와 다르면 거절된다.
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
    private readonly templates: NotificationTemplatesService,
  ) {}

  async send(
    templateCode: string,
    to: string,
    variables: Record<string, string>,
  ): Promise<AlimtalkSendResult> {
    const phone = to.replace(/\D/g, '');
    if (!MOBILE.test(phone))
      throw new Error(`휴대폰 번호가 아닙니다: ${maskPhone(phone)}`);
    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const { body: message, kakaoTemplateCode } = await this.templates.render(
      templateCode,
      'ALIMTALK',
      variables,
    );
    // render 가 알림톡 행에 kakao_template_code 가 있고 title 이 없음을 확인했다.
    // 강조 표기형 제목은 보내지 않는다.
    const kakaoCode = kakaoTemplateCode as string;

    const refKey = randomUUID().replace(/-/g, '').slice(0, 20);
    const at: BizppurioMessage['content']['at'] = {
      senderkey: this.config.senderKey,
      templatecode: kakaoCode,
      message,
    };

    try {
      const response = await this.client.sendMessage({
        account: this.config.account,
        type: 'at',
        refkey: refKey,
        to: phone,
        content: { at },
      });
      this.logger.log(
        `alimtalk ACCEPTED template=${templateCode} kakaoTemplate=${kakaoCode} refKey=${refKey} messageKey=${response.messagekey} to=${maskPhone(phone)}`,
      );
      return { refKey, messageKey: response.messagekey };
    } catch (e) {
      const { code: bizCode, httpStatus } =
        e instanceof BizppurioError ? e : ({} as BizppurioError);
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
      this.logger.warn(
        `alimtalk FAILED template=${templateCode} kakaoTemplate=${kakaoCode} refKey=${refKey} code=${bizCode} http=${httpStatus} to=${maskPhone(phone)}: ${(e as Error).message}`,
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
