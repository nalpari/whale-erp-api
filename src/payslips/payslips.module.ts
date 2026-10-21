import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { MyPayslipsController } from './my-payslips.controller';
import { MyPayslipsService } from './my-payslips.service';
import { PayslipDraftService } from './payslip-draft.service';
import { PayslipEditService } from './payslip-edit.service';
import { PayslipListService } from './payslip-list.service';
import { PayslipSendService } from './payslip-send.service';
import { PayslipsController } from './payslips.controller';

@Module({
  imports: [AdminScopeModule],
  controllers: [PayslipsController, MyPayslipsController],
  providers: [
    PayslipListService,
    PayslipDraftService,
    PayslipEditService,
    PayslipSendService,
    MyPayslipsService,
    // 메일 설정(MAIL_*)이 둘 다 비면 null — api 는 뜨고 발송만 실패로 알린다(문의 · 도입문의와 같다)
    optionalMailServiceProvider,
  ],
})
export class PayslipsModule {}
