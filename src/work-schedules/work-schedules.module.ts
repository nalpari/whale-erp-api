import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { WorkSchedulePurgeScheduler } from './work-schedule-purge';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';

@Module({
  imports: [AdminScopeModule, BatchModule],
  controllers: [WorkSchedulesController],
  providers: [WorkSchedulesService, WorkSchedulePurgeScheduler],
})
export class WorkSchedulesModule {}
