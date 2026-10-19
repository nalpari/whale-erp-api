import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { SupportInquiriesController } from './support-inquiries.controller';
import { SupportInquiriesService } from './support-inquiries.service';

@Module({
  imports: [AdminScopeModule, NotificationsModule, StorageModule],
  controllers: [InquiriesController, SupportInquiriesController],
  providers: [
    InquiriesService,
    SupportInquiriesService,
    optionalMailServiceProvider,
  ],
})
export class InquiriesModule {}
