import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MAIL_CONFIG, type MailConfig, readMailConfig } from './mail.config';
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

// 메일을 보내는 모듈이 import 한다. import 되는 순간 MAIL_* 를 읽어 하나라도
// 비면 기동을 멈춘다 — AdminSignupModule 이 처음 import 해서(2026-10-12) 이제
// AppModule 전체가 뜨는 데도 MAIL_USERNAME·MAIL_PASSWORD 가 있어야 한다.
// 배포 환경(.env.dev·.env.prod)과 e2e·openapi:export 환경에도 넣어야 한다.
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
