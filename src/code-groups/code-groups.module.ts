import { Module } from '@nestjs/common';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';

@Module({
  imports: [MenuPermissionsModule],
  controllers: [CodeGroupsController],
  providers: [CodeGroupsService],
})
export class CodeGroupsModule {}
