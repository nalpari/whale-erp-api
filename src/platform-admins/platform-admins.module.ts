import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPlatformAdminMail,
  PLATFORM_ADMIN_MAIL,
} from './platform-admin-mail';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAdminsService } from './platform-admins.service';

// MailModule 을 import 하지 않는다 — 메일 설정이 없어도 api 는 떠야 한다(createPlatformAdminMail).
@Module({
  imports: [MenuPermissionsModule],
  controllers: [PlatformAdminsController],
  providers: [
    PlatformAdminsService,
    {
      provide: PLATFORM_ADMIN_MAIL,
      inject: [ConfigService, PrismaService],
      useFactory: createPlatformAdminMail,
    },
  ],
})
export class PlatformAdminsModule {}
