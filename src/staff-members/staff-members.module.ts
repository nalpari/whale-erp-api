import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { RetirementController } from './retirement.controller';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [RetirementController],
  providers: [RetirementService, RetirementScheduler],
  exports: [RetirementService],
})
export class StaffMembersModule {}
