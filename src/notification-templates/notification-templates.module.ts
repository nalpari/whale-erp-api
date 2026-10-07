import { Module } from '@nestjs/common';
import { NotificationTemplatesService } from './notification-templates.service';

// PrismaService 는 전역 PrismaModule 이 준다.
@Module({
  providers: [NotificationTemplatesService],
  exports: [NotificationTemplatesService],
})
export class NotificationTemplatesModule {}
