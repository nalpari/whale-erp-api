import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { MenuPermissionsModule } from '../menu-permissions/menu-permissions.module';
import { StorageModule } from '../storage/storage.module';
import {
  PlatformFaqsController,
  PlatformNoticesController,
} from './posts.controller';
import { PostsService } from './posts.service';
import {
  PublicFaqsController,
  PublicNoticesController,
} from './public-posts.controller';
import { PublishedPostsService } from './published-posts.service';
import {
  SupportFaqsController,
  SupportNoticesController,
} from './support-posts.controller';

@Module({
  imports: [AdminScopeModule, MenuPermissionsModule, StorageModule],
  controllers: [
    PlatformNoticesController,
    PlatformFaqsController,
    SupportNoticesController,
    SupportFaqsController,
    PublicNoticesController,
    PublicFaqsController,
  ],
  providers: [PostsService, PublishedPostsService],
})
export class PostsModule {}
