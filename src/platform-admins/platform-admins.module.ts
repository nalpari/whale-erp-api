import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ADMIN_WEB_URL, readAdminWebUrl } from '../admin-signup/admin-web-url';
import { MailModule } from '../mail/mail.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAdminsService } from './platform-admins.service';

// MailModule 을 들이므로 이 모듈이 AppModule 에 있으면 MAIL_USERNAME · MAIL_PASSWORD 가 없을 때 기동이 멈춘다.
// 메일의 바로가기 버튼(#{링크})이 관리자 웹으로 가도록 ADMIN_WEB_URL 을 읽는다 — 비면 기동이 멈춘다.
// 읽는 함수는 BP 회원가입(api #16 의 AdminSignupModule)과 같은 src/admin-signup/admin-web-url.ts 를 쓴다 —
// 그 PR 이 먼저 들어가면 이 파일은 같은 내용이라 그대로 겹친다.
@Module({
  imports: [MailModule, MenuPermissionsModule],
  controllers: [PlatformAdminsController],
  providers: [
    PlatformAdminsService,
    {
      provide: ADMIN_WEB_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readAdminWebUrl(config.get<string>('ADMIN_WEB_URL')),
    },
  ],
})
export class PlatformAdminsModule {}
