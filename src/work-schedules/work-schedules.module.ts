import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';

@Module({
  imports: [AdminScopeModule],
  controllers: [WorkSchedulesController],
  providers: [WorkSchedulesService],
})
export class WorkSchedulesModule {}
