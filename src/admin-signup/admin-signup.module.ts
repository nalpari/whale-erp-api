import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { NtsModule } from '../nts/nts.module';
import { AdminSignupController } from './admin-signup.controller';
import { AdminSignupService } from './admin-signup.service';
import { BusinessVerificationService } from './business-verification.service';

// 가입 메일은 부가 기능이라 MailModule 을 import 하지 않는다 — MAIL_* · ADMIN_WEB_URL 이 없어도 api 가
// 뜨고 메일만 건너뛴다. JwtService 와 요청 제한은 AuthModule 이 내보낸 것을 쓴다.
//
// 국세청 키(NTS_SERVICE_KEY)는 메일과 다르다 — 운영에서 없으면 NtsModule 이 기동을 멈춘다.
@Module({
  imports: [AuthModule, NtsModule],
  controllers: [AdminSignupController],
  providers: [
    AdminSignupService,
    BusinessVerificationService,
    optionalMailServiceProvider,
  ],
})
export class AdminSignupModule {}
