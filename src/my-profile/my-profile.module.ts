import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthSessionModule } from '../auth-session/auth-session.module';
import { personalDataKeyProvider } from '../common/personal-data-key.provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  createEmailChangePinSender,
  EmailChangePinSender,
} from './email-change-pin-sender';
import { MyAddressService } from './my-address.service';
import { MyConsentController } from './my-consent.controller';
import { MyConsentService } from './my-consent.service';
import { MyEmailChangeService } from './my-email-change.service';
import { MyMembershipsController } from './my-memberships.controller';
import { MyMembershipsService } from './my-memberships.service';
import { MyPasswordService } from './my-password.service';
import { MyProfileController } from './my-profile.controller';
import { MyProfileService } from './my-profile.service';

@Module({
  imports: [AuthSessionModule],
  controllers: [
    MyProfileController,
    MyMembershipsController,
    MyConsentController,
  ],
  providers: [
    MyProfileService,
    MyMembershipsService,
    MyAddressService,
    MyPasswordService,
    MyConsentService,
    MyEmailChangeService,
    // MAIL_* 가 있으면 MailService 로 보내고, 없으면 핀 요청만 503 이다(WHALEERP-191).
    {
      provide: EmailChangePinSender,
      inject: [ConfigService, PrismaService],
      useFactory: createEmailChangePinSender,
    },
    personalDataKeyProvider,
  ],
})
export class MyProfileModule {}
