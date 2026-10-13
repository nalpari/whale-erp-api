import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { RetirementController } from './retirement.controller';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMembersController } from './staff-members.controller';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [StaffMembersController, RetirementController],
  providers: [RetirementService, RetirementScheduler, StaffMemberListService],
  exports: [RetirementService],
})
export class StaffMembersModule {}
