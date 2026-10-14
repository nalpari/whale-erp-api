import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAIL_CONFIG,
  type MailConfig,
  readMailConfig,
  readOptionalMailConfig,
} from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';

// 기본값은 연결 2분, 소켓 10분이라 Gmail 이 멈추면 호출부도 그만큼 묶인다.
// 기다림 하나하나의 한도이지 발송 전체의 상한은 아니다.
const TIMEOUT_MS = 30_000;

/** Gmail SMTP 연결. MailModule 과, 메일 없이도 떠야 해 MailModule 을 import 하지 않는 곳이 함께 쓴다. */
export function createMailTransport(config: MailConfig) {
  // 465 는 처음부터 TLS 다. 587(STARTTLS)과 달리 평문으로 시작하지 않는다.
  return createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

/** `MAIL_*` 가 없으면 null 인 MailService. 메일 없이도 떠야 하는 업무 모듈이 주입받는다. */
export const OPTIONAL_MAIL_SERVICE = Symbol('OPTIONAL_MAIL_SERVICE');

/**
 * MailModule 을 import 하지 않고 메일을 보내는 모듈이 providers 에 넣는다. MailModule 은 `MAIL_*` 가 비면 기동을
 * 멈추지만, 메일이 부가 기능인 곳(문의 답변 알림 등)은 메일 설정 없이도 떠야 한다. 반만 넣은 설정은 기동 때 던진다.
 */
export const optionalMailServiceProvider: Provider = {
  provide: OPTIONAL_MAIL_SERVICE,
  inject: [ConfigService, PrismaService],
  useFactory: (
    config: ConfigService,
    prisma: PrismaService,
  ): MailService | null => {
    const mail = readOptionalMailConfig((key) => config.get<string>(key));
    return mail && new MailService(createMailTransport(mail), mail, prisma);
  },
};

// 메일을 보내는 모듈이 import 한다. import 되는 순간 MAIL_* 를 읽어 하나라도
// 비면 기동을 멈추므로, 쓰는 곳이 없는 지금은 AppModule 에 넣지 않는다.
// PrismaService 는 전역 PrismaModule 에서 온다.
@Module({
  providers: [
    {
      provide: MAIL_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readMailConfig((key) => config.get<string>(key)),
    },
    {
      provide: MAIL_TRANSPORT,
      inject: [MAIL_CONFIG],
      useFactory: createMailTransport,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
