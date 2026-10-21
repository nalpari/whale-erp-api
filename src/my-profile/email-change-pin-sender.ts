import type { ConfigService } from '@nestjs/config';
import { readOptionalMailConfig } from '../mail/mail.config';
import { createMailTransport } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * 이메일 변경 핀을 새 이메일로 보내는 쪽 (WHALEERP-191). `MAIL_*` 가 없으면 쓸 수 없는 발송기이고 핀 요청은 503 이다 —
 * 보내지 못하면서 보냈다고 답하면 직원은 오지 않을 메일을 기다린다.
 */
export abstract class EmailChangePinSender {
  /** 지금 핀을 실제로 보낼 수 있는지. false 면 핀 요청은 저장 없이 503 이다. */
  abstract isAvailable(): boolean;

  /**
   * 실패하거나 나갔는지 모르면(타임아웃) 던진다 — 서비스가 방금 저장한 핀을 지운다. SMTP 단계 실패는 MailService 가
   * 표시해 503, 그 밖(템플릿 꺼짐 · DB)은 500 이 된다. 오류 메시지에 핀을 싣지 않는다.
   */
  abstract send(to: string, pin: string): Promise<void>;
}

/** 템플릿 `EMAIL_CHANGE_PIN`(변수 핀). 핀은 발송 이력(`mail_send_logs`)에서 가린다 */
export class MailEmailChangePinSender extends EmailChangePinSender {
  constructor(private readonly mail: Pick<MailService, 'send'>) {
    super();
  }

  isAvailable(): boolean {
    return true;
  }

  async send(to: string, pin: string): Promise<void> {
    await this.mail.send({
      templateCode: 'EMAIL_CHANGE_PIN',
      to,
      variables: { 핀: pin },
      maskedVariables: ['핀'],
    });
  }
}

export class NoopEmailChangePinSender extends EmailChangePinSender {
  isAvailable(): boolean {
    return false;
  }

  send(): Promise<void> {
    return Promise.reject(
      new Error('메일 설정이 없어 이메일 변경 핀을 보낼 수 없다'),
    );
  }
}

/**
 * 재설정 링크 발송기(`createPasswordResetLinkSender`)와 같은 이유로 MailModule 을 import 하지 않는다 — 그 모듈은 `MAIL_*` 가
 * 비면 기동을 멈춘다. 반만 넣은 설정은 기동 때 던진다.
 */
export function createEmailChangePinSender(
  config: Pick<ConfigService, 'get'>,
  prisma: PrismaService,
): EmailChangePinSender {
  const mail = readOptionalMailConfig((key) => config.get<string>(key));
  if (mail === null) return new NoopEmailChangePinSender();
  return new MailEmailChangePinSender(
    new MailService(createMailTransport(mail), mail, prisma),
  );
}
