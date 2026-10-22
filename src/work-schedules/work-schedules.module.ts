import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { MyWorkSchedulesController } from './my-work-schedules.controller';
import { WorkSchedulePurgeScheduler } from './work-schedule-purge';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';

@Module({
  imports: [AdminScopeModule, BatchModule],
  controllers: [WorkSchedulesController, MyWorkSchedulesController],
  providers: [WorkSchedulesService, WorkSchedulePurgeScheduler],
})
export class WorkSchedulesModule {}
