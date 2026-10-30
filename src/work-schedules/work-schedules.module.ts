import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { MyWorkSchedulesController } from './my-work-schedules.controller';
import { WorkSchedulePurgeScheduler } from './work-schedule-purge';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';

@Module({
  imports: [AdminScopeModule, BatchModule],
  controllers: [WorkSchedulesController, MyWorkSchedulesController],
  providers: [
    WorkSchedulesService,
    WorkSchedulePurgeScheduler,
    // 메일 설정(MAIL_*)이 없으면 null — 근무스케줄 변경 메일만 건너뛴다(WHALEERP-639)
    optionalMailServiceProvider,
  ],
})
export class WorkSchedulesModule {}
