import type { ConfigService } from '@nestjs/config';
import { readOptionalMailConfig } from '../mail/mail.config';
import { createMailTransport } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MailPasswordResetLinkSender } from './mail-password-reset-link.sender';
import { NoopPasswordResetLinkSender } from './noop-password-reset-link.sender';
import { PasswordResetLinkSender } from './password-reset-link-sender';

/**
 * 링크 발송기를 고른다. `MAIL_*` 가 있으면 MailService 로 보내고, 없으면 쓸 수 없는 발송기다(발급 503).
 * MailModule 을 import 하지 않는 것은 그 모듈이 `MAIL_*` 가 비면 기동을 멈춰서다 — 메일 설정이 없는 환경에서도
 * 로그인 등 나머지는 떠야 한다. 반만 넣은 설정은 기동 때 던진다.
 */
export function createPasswordResetLinkSender(
  config: Pick<ConfigService, 'get'>,
  prisma: PrismaService,
): PasswordResetLinkSender {
  const mail = readOptionalMailConfig((key) => config.get<string>(key));
  if (mail === null) return new NoopPasswordResetLinkSender();
  return new MailPasswordResetLinkSender(
    new MailService(createMailTransport(mail), mail, prisma),
  );
}
