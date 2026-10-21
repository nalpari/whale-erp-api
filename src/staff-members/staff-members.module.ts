import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { RetirementController } from './retirement.controller';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMemberSummaryController } from './staff-member-summary.controller';
import { StaffMemberSummaryService } from './staff-member-summary.service';
import { StaffMembersController } from './staff-members.controller';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [
    StaffMembersController,
    StaffMemberSummaryController,
    RetirementController,
  ],
  providers: [
    RetirementService,
    RetirementScheduler,
    StaffMemberListService,
    StaffMemberSummaryService,
  ],
  exports: [RetirementService],
})
export class StaffMembersModule {}
