import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPlatformAdminMail,
  PLATFORM_ADMIN_MAIL,
} from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
import { BpAdminsController } from './bp-admins.controller';
import { BpAdminsService } from './bp-admins.service';

// MailModule 을 import 하지 않는다 — 메일 설정이 없어도 api 는 떠야 한다(createPlatformAdminMail).
@Module({
  controllers: [BpAdminsController],
  providers: [
    BpAdminsService,
    {
      provide: PLATFORM_ADMIN_MAIL,
      inject: [ConfigService, PrismaService],
      useFactory: createPlatformAdminMail,
    },
  ],
})
export class BpAdminsModule {}
