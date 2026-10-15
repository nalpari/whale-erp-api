import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { NtsBusinessClient } from '../nts/nts-business.client';
import { NtsModule } from '../nts/nts.module';
import { StorageModule } from '../storage/storage.module';
import { NtsStoreBusinessVerifier } from './nts-store-business-verifier';
import { STORE_BUSINESS_VERIFIER } from './store-business-verifier';
import { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  imports: [AdminScopeModule, MenuPermissionsModule, StorageModule, NtsModule],
  controllers: [StoresController],
  providers: [
    StoresService,
    StoreManagementService,
    // 회원가입과 같은 국세청 클라이언트로 진위확인한다. 키가 없으면(개발 환경) null 이다 — 클릭마다 「잠시 뒤
    // 다시」 503 과 오류 로그를 내는 대신, 「연동이 없다」 503 과 기동 경고 한 번으로 설정이 빠진 것을 알린다.
    {
      provide: STORE_BUSINESS_VERIFIER,
      inject: [NtsBusinessClient],
      useFactory: (client: NtsBusinessClient) =>
        client.isConfigured ? new NtsStoreBusinessVerifier(client) : null,
    },
  ],
})
export class StoresModule {}
