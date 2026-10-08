import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MAIL_CONFIG, type MailConfig, readMailConfig } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';

// 기본값은 연결 2분, 소켓 10분이라 Gmail 이 멈추면 호출부도 그만큼 묶인다.
// 기다림 하나하나의 한도이지 발송 전체의 상한은 아니다.
const TIMEOUT_MS = 30_000;

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
      // 465 는 처음부터 TLS 다. 587(STARTTLS)과 달리 평문으로 시작하지 않는다.
      useFactory: (config: MailConfig) =>
        createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: { user: config.username, pass: config.password },
          connectionTimeout: TIMEOUT_MS,
          socketTimeout: TIMEOUT_MS,
        }),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
