import { Module } from '@nestjs/common';
import { CodesModule } from '../codes/codes.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { PlatformRoleGroupMenusService } from './platform-role-group-menus.service';
import { PlatformRoleGroupsController } from './platform-role-groups.controller';
import { PlatformRoleGroupsService } from './platform-role-groups.service';

@Module({
  imports: [CodesModule, MenuPermissionsModule],
  controllers: [PlatformRoleGroupsController],
  providers: [PlatformRoleGroupsService, PlatformRoleGroupMenusService],
})
export class PlatformRoleGroupsModule {}
