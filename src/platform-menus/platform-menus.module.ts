import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiMenuUrlsService } from './api-menu-urls.service';
import { PlatformMenusController } from './platform-menus.controller';
import { PlatformMenusService } from './platform-menus.service';

@Module({
  imports: [DiscoveryModule],
  controllers: [PlatformMenusController],
  providers: [PlatformMenusService, ApiMenuUrlsService],
})
export class PlatformMenusModule {}
