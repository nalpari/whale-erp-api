import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { RetirementController } from './retirement.controller';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMemberSummaryController } from './staff-member-summary.controller';
import { StaffMemberSummaryService } from './staff-member-summary.service';
import { StaffMemberWorkSchedulesController } from './staff-member-work-schedules.controller';
import { StaffMemberWorkSchedulesService } from './staff-member-work-schedules.service';
import { StaffMembersController } from './staff-members.controller';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [
    StaffMembersController,
    StaffMemberSummaryController,
    StaffMemberWorkSchedulesController,
    RetirementController,
  ],
  providers: [
    RetirementService,
    RetirementScheduler,
    StaffMemberListService,
    StaffMemberSummaryService,
    StaffMemberWorkSchedulesService,
  ],
  exports: [RetirementService],
})
export class StaffMembersModule {}
