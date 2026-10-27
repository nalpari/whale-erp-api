import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { AttendanceRecordsController } from './attendance-records.controller';
import { AttendanceEditService } from './attendance-edit.service';
import { AttendanceRecordsService } from './attendance-records.service';
import { AttendancePurgeScheduler } from './attendance-purge';
import { MyAttendanceController } from './my-attendance.controller';
import { MyAttendanceService } from './my-attendance.service';

@Module({
  imports: [AdminScopeModule, BatchModule],
  controllers: [MyAttendanceController, AttendanceRecordsController],
  providers: [
    AttendancePurgeScheduler,
    MyAttendanceService,
    AttendanceRecordsService,
    AttendanceEditService,
  ],
})
export class AttendanceModule {}
