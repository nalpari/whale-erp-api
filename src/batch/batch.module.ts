import { Module } from '@nestjs/common';
import { BatchLockService } from './batch-lock.service';

@Module({
  providers: [BatchLockService],
  exports: [BatchLockService],
})
export class BatchModule {}
