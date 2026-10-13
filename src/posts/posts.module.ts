import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [AdminScopeModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
