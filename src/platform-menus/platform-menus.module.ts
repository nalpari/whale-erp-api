import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { PlatformMenusController } from './platform-menus.controller';
import { PlatformMenusService } from './platform-menus.service';

@Module({
  imports: [AdminScopeModule, MenuPermissionsModule],
  controllers: [PlatformMenusController],
  providers: [PlatformMenusService],
})
export class PlatformMenusModule {}
