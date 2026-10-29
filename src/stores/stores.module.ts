import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { ExcelExportsModule } from '../excel-exports/excel-exports.module';
import { NtsBusinessClient } from '../nts/nts-business.client';
import { NtsModule } from '../nts/nts.module';
import { StorageModule } from '../storage/storage.module';
import { storeBusinessVerifierFor } from './nts-store-business-verifier';
import { STORE_BUSINESS_VERIFIER } from './store-business-verifier';
import { StoreExcelSource } from './store-excel.source';
import { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  imports: [AdminScopeModule, StorageModule, NtsModule, ExcelExportsModule],
  controllers: [StoresController],
  providers: [
    StoresService,
    StoreManagementService,
    StoreExcelSource,
    // 회원가입과 같은 국세청 클라이언트로 진위확인한다. 키가 없으면 null 이다(storeBusinessVerifierFor).
    {
      provide: STORE_BUSINESS_VERIFIER,
      inject: [NtsBusinessClient],
      useFactory: storeBusinessVerifierFor,
    },
  ],
})
export class StoresModule {}
