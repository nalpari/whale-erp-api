import { Module } from '@nestjs/common';
import { BpCodeGroupsController } from './bp-code-groups.controller';
import { BpCodeGroupsService } from './bp-code-groups.service';

@Module({
  controllers: [BpCodeGroupsController],
  providers: [BpCodeGroupsService],
})
export class BpCodeGroupsModule {}
