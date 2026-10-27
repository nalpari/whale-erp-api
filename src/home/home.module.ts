import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [AdminScopeModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
