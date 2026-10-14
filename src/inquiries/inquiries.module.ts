import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';

@Module({
  imports: [AdminScopeModule, NotificationsModule, StorageModule],
  controllers: [InquiriesController],
  providers: [InquiriesService, optionalMailServiceProvider],
})
export class InquiriesModule {}
