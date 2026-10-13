import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  imports: [AdminScopeModule],
  controllers: [StoresController],
  providers: [StoresService],
})
export class StoresModule {}
