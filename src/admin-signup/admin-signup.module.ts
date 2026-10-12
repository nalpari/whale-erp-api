import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { AdminSignupController } from './admin-signup.controller';
import { AdminSignupService } from './admin-signup.service';
import { ADMIN_WEB_URL, readAdminWebUrl } from './admin-web-url';

// MailModule 을 import 하므로 MAIL_* 가, ADMIN_WEB_URL 을 읽으므로 그 값이 비면 기동이 멈춘다.
// JwtService 와 요청 제한은 AuthModule 이 내보낸 것을 쓴다.
@Module({
  imports: [AuthModule, MailModule],
  controllers: [AdminSignupController],
  providers: [
    AdminSignupService,
    {
      provide: ADMIN_WEB_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readAdminWebUrl(config.get<string>('ADMIN_WEB_URL')),
    },
  ],
})
export class AdminSignupModule {}
