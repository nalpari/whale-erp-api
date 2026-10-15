import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PublicPostsController } from './public-posts.controller';
import { PublishedPostsService } from './published-posts.service';
import { SupportPostsController } from './support-posts.controller';

@Module({
  imports: [AdminScopeModule],
  controllers: [PostsController, PublicPostsController, SupportPostsController],
  providers: [PostsService, PublishedPostsService],
})
export class PostsModule {}
