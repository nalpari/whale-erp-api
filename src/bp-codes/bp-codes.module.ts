import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { CodesModule } from '../codes/codes.module';
import { BpCodesController } from './bp-codes.controller';

@Module({
  imports: [AdminScopeModule, CodesModule],
  controllers: [BpCodesController],
})
export class BpCodesModule {}
