import type { ConfigService } from '@nestjs/config';
import { readOptionalAdminWebUrl } from '../common/admin-web-url';
import { isProduction } from '../config/profile';
import { readOptionalMailConfig } from '../mail/mail.config';
import { createMailTransport } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';

export const PLATFORM_ADMIN_MAIL = Symbol('PLATFORM_ADMIN_MAIL');

/** 초기 · 초기화 비밀번호 메일을 보낼 수단. 보낼 수 없는 환경이면 null — 등록 · 초기화는 「미발송」으로 남는다. */
export type PlatformAdminMail = {
  mail: MailService;
  /** 관리자 웹 주소. 메일의 바로가기 버튼(#{링크})이 여기로 간다 */
  webUrl: string;
} | null;

/**
 * 발송 수단을 고른다. `MAIL_*` 와 `ADMIN_WEB_URL` 이 다 있어야 보낸다.
 * MailModule 을 import 하지 않는 것은 그 모듈이 `MAIL_*` 가 비면 기동을 멈춰서다 — 메일 설정이 없는 환경에서도
 * api 는 떠야 한다(main, PR #28 · AuthModule 의 재설정 링크와 같다). 반만 넣은 메일 설정과 http(s) 가 아닌
 * 주소는 실수이므로 기동 때 던진다.
 */
export function createPlatformAdminMail(
  config: Pick<ConfigService, 'get'>,
  prisma: PrismaService,
): PlatformAdminMail {
  const get = (key: string) => config.get<string>(key);
  const mail = readOptionalMailConfig(get);
  const webUrl = readOptionalAdminWebUrl(get('ADMIN_WEB_URL'), isProduction());
  if (mail === null || webUrl === null) return null;
  return {
    mail: new MailService(createMailTransport(mail), mail, prisma),
    webUrl,
  };
}
