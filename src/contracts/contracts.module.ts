import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { AlimtalkModule } from '../alimtalk/alimtalk.module';
import { BatchModule } from '../batch/batch.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';
import { ContractFilesScheduler } from './contract-files.scheduler';
import { ContractFilesService } from './contract-files.service';
import { ContractNoticeService } from './contract-notice.service';
import { ContractSendController } from './contract-send.controller';
import { ContractSendService } from './contract-send.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { MyContractDocumentsController } from './my-contract-documents.controller';
import { MyContractDocumentsService } from './my-contract-documents.service';
import { MyContractViewsController } from './my-contract-views.controller';
import { MyContractViewsService } from './my-contract-views.service';
import { MyContractsController } from './my-contracts.controller';
import { MyContractsService } from './my-contracts.service';

// 알림톡(저장하면 보내기 · 재발송, WHALEERP-136)을 쓰므로 AlimtalkModule 을 import 한다 — BIZPPURIO_* 가 하나라도 비면 api 가 뜨지 않는다
// (2026-10-16 김민식 결정: 필수로 둔다). 직원 앱 주소 STAFF_APP_URL 은 없어도 뜨고 발송만 503 이다.
// 날인 · 거부 · 만료 · 갱신 예정 알림(WHALEERP-154 · 152)은 운영 알림(NotificationsModule)과 메일을 쓴다 — 메일은 부가 기능이라
// MAIL_* 가 없어도 뜨게 optionalMailServiceProvider 를 넣는다(문의 답변과 같다).
@Module({
  imports: [
    BatchModule,
    AdminScopeModule,
    StorageModule,
    AlimtalkModule,
    NotificationsModule,
  ],
  controllers: [
    ContractsController,
    ContractSendController,
    MyContractsController,
    MyContractViewsController,
    MyContractDocumentsController,
  ],
  providers: [
    ContractsService,
    ContractDeliveryService,
    ContractSendService,
    MyContractsService,
    MyContractViewsService,
    MyContractDocumentsService,
    ContractExpiryService,
    ContractExpiryScheduler,
    ContractFilesService,
    ContractFilesScheduler,
    ContractNoticeService,
    optionalMailServiceProvider,
  ],
})
export class ContractsModule {}
