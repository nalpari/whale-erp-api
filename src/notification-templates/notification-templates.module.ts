import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTemplatesService } from './notification-templates.service';

@Module({
  imports: [AdminScopeModule],
  controllers: [NotificationTemplatesController],
  providers: [NotificationTemplatesService],
})
export class NotificationTemplatesModule {}
