import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { StorageModule } from '../storage/storage.module';
import { STORE_BUSINESS_VERIFIER } from './store-business-verifier';
import { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  imports: [AdminScopeModule, MenuPermissionsModule, StorageModule],
  controllers: [StoresController],
  providers: [
    StoresService,
    StoreManagementService,
    // 국세청 사업자 진위확인 연동이 아직 없다 — 인증을 요구하는 요청은 503. 연동을 만들면 이 자리를 바꾼다.
    { provide: STORE_BUSINESS_VERIFIER, useValue: null },
  ],
})
export class StoresModule {}
