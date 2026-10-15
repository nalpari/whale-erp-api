import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LeadPurgeScheduler } from './lead-purge.scheduler';
import { LeadsAdminController } from './leads-admin.controller';
import { LeadsAdminService } from './leads-admin.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [BatchModule, AdminScopeModule, NotificationsModule],
  controllers: [LeadsController, LeadsAdminController],
  providers: [
    LeadsService,
    LeadsAdminService,
    LeadPurgeScheduler,
    optionalMailServiceProvider,
  ],
})
export class LeadsModule {}
