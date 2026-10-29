import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { StorageModule } from '../storage/storage.module';
import { BulkExportsController } from './bulk-exports.controller';
import { BulkExportsScheduler } from './bulk-exports.scheduler';
import { BulkExportsService } from './bulk-exports.service';

// 직원 자료 일괄 저장. 경로가 /staff-members/bulk-exports 라 AppModule 에서 StaffMembersModule 보다 먼저 import 한다 —
// 늦으면 GET /staff-members/:id 가 bulk-exports 를 직원 ID 로 받아 404 다.
@Module({
  imports: [AdminScopeModule, BatchModule, StorageModule],
  controllers: [BulkExportsController],
  providers: [BulkExportsService, BulkExportsScheduler],
})
export class BulkExportsModule {}
