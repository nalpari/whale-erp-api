import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  imports: [BatchModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractExpiryService, ContractExpiryScheduler],
})
export class ContractsModule {}
