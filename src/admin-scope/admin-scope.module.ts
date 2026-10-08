import { Module } from '@nestjs/common';
import { AdminScopeService } from './admin-scope.service';

@Module({
  providers: [AdminScopeService],
  exports: [AdminScopeService],
})
export class AdminScopeModule {}
