import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { AlimtalkModule } from '../alimtalk/alimtalk.module';
import { BatchModule } from '../batch/batch.module';
import { StorageModule } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';
import { ContractSendController } from './contract-send.controller';
import { ContractSendService } from './contract-send.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { MyContractsController } from './my-contracts.controller';
import { MyContractsService } from './my-contracts.service';

// 알림톡(저장하면 보내기 · 재발송, WHALEERP-136)을 쓰므로 AlimtalkModule 을 import 한다 — BIZPPURIO_* 가 하나라도 비면 api 가 뜨지 않는다
// (2026-10-16 김민식 결정: 필수로 둔다). 직원 앱 주소 STAFF_APP_URL 은 없어도 뜨고 발송만 503 이다.
@Module({
  imports: [BatchModule, AdminScopeModule, StorageModule, AlimtalkModule],
  controllers: [
    ContractsController,
    ContractSendController,
    MyContractsController,
  ],
  providers: [
    ContractsService,
    ContractDeliveryService,
    ContractSendService,
    MyContractsService,
    ContractExpiryService,
    ContractExpiryScheduler,
  ],
})
export class ContractsModule {}
