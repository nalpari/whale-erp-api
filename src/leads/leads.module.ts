import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { LeadPurgeScheduler } from './lead-purge.scheduler';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [BatchModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadPurgeScheduler],
})
export class LeadsModule {}
