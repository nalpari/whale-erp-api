import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessVerificationService } from '../admin-signup/business-verification.service';
import { AuthModule } from '../auth/auth.module';
import { ExcelExportsModule } from '../excel-exports/excel-exports.module';
import { NtsModule } from '../nts/nts.module';
import {
  createPlatformAdminMail,
  PLATFORM_ADMIN_MAIL,
} from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
import { BpMasterExcelSource } from './bp-master-excel.source';
import { BpMastersController } from './bp-masters.controller';
import { BpMastersService } from './bp-masters.service';

// MailModule 을 import 하지 않는다 — 메일 설정이 없어도 api 는 떠야 한다(플랫폼 관리자와 같은 발송 수단).
// 국세청 키도 선택이다 — 없으면 NtsModule 이 진위확인만 503 으로 만든다. JwtService(인증 토큰)와 요청 제한은
// AuthModule 이 내보낸 것을 쓴다(AdminSignupModule 과 같다).
@Module({
  imports: [AuthModule, NtsModule, ExcelExportsModule],
  controllers: [BpMastersController],
  providers: [
    BpMastersService,
    BpMasterExcelSource,
    BusinessVerificationService,
    {
      provide: PLATFORM_ADMIN_MAIL,
      inject: [ConfigService, PrismaService],
      useFactory: createPlatformAdminMail,
    },
  ],
})
export class BpMastersModule {}
