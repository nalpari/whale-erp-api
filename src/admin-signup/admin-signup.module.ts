import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { isProduction } from '../config/profile';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { AdminSignupController } from './admin-signup.controller';
import { AdminSignupService } from './admin-signup.service';
import { BusinessVerificationService } from './business-verification.service';
import { NtsBusinessClient } from './nts-business.client';

// 가입 메일은 부가 기능이라 MailModule 을 import 하지 않는다 — MAIL_* · ADMIN_WEB_URL 이 없어도 api 가
// 뜨고 메일만 건너뛴다. JwtService 와 요청 제한은 AuthModule 이 내보낸 것을 쓴다.
//
// 국세청 키(NTS_SERVICE_KEY)는 메일과 다르다 — 없으면 「인증완료」를 줄 수 없어 사업자정보 인증이 늘 실패한다.
// 운영에서는 기동을 멈추고, 개발에서는 기동하되 인증하기가 503 이 된다.
@Module({
  imports: [AuthModule],
  controllers: [AdminSignupController],
  providers: [
    AdminSignupService,
    BusinessVerificationService,
    optionalMailServiceProvider,
    {
      provide: NtsBusinessClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('NTS_SERVICE_KEY')?.trim();
        if (!key && isProduction())
          throw new Error('NTS_SERVICE_KEY 가 비어 있다');
        return new NtsBusinessClient(key);
      },
    },
  ],
})
export class AdminSignupModule {}
