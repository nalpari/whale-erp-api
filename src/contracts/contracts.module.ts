import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { StorageModule } from '../storage/storage.module';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  imports: [BatchModule, AdminScopeModule, StorageModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractExpiryService, ContractExpiryScheduler],
})
export class ContractsModule {}
