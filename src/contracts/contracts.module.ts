import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';

// AppModule 에 아직 넣지 않는다. contracts · contract_status_histories 테이블이
// DB 에 생기기 전에 넣으면 만료 배치가 매일 자정 실패한다. 두 테이블의
// 마이그레이션이 들어가면 AppModule imports 에 넣고 이 주석을 지운다.
@Module({
  imports: [BatchModule],
  providers: [ContractExpiryService, ContractExpiryScheduler],
})
export class ContractsModule {}
