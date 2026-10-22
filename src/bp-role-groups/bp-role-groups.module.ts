import { Module } from '@nestjs/common';
import { CodesModule } from '../codes/codes.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { BpRoleGroupMenusService } from './bp-role-group-menus.service';
import { BpRoleGroupsController } from './bp-role-groups.controller';
import { BpRoleGroupsService } from './bp-role-groups.service';

@Module({
  imports: [CodesModule, MenuPermissionsModule],
  controllers: [BpRoleGroupsController],
  providers: [BpRoleGroupsService, BpRoleGroupMenusService],
})
export class BpRoleGroupsModule {}
