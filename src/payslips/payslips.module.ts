import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { MyPayslipsController } from './my-payslips.controller';
import { MyPayslipsService } from './my-payslips.service';
import { PayslipDraftService } from './payslip-draft.service';
import { PayslipListService } from './payslip-list.service';
import { PayslipsController } from './payslips.controller';

@Module({
  imports: [AdminScopeModule],
  controllers: [PayslipsController, MyPayslipsController],
  providers: [PayslipListService, PayslipDraftService, MyPayslipsService],
})
export class PayslipsModule {}
