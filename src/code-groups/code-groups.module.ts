import { Module } from '@nestjs/common';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';

@Module({
  controllers: [CodeGroupsController],
  providers: [CodeGroupsService],
})
export class CodeGroupsModule {}
