import { Module } from '@nestjs/common';
import { PlatformMenusController } from './platform-menus.controller';
import { PlatformMenusService } from './platform-menus.service';

@Module({
  controllers: [PlatformMenusController],
  providers: [PlatformMenusService],
})
export class PlatformMenusModule {}
