import { Module } from '@nestjs/common';
import { MenuPermissionsService } from './menu-permissions.service';

@Module({
  providers: [MenuPermissionsService],
  exports: [MenuPermissionsService],
})
export class MenuPermissionsModule {}
