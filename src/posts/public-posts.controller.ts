import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiNotFoundResponse } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { parseRouteId } from '../common/route-id';
import { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import {
  PublishedPostDto,
  PublishedPostListResponseDto,
} from './dto/published-post.response.dto';
import { PublishedPostsService } from './published-posts.service';

/**
 * 비로그인 홈의 공지사항 · FAQ (WHALEERP-292). 노출 대상에 비회원이 든 게시 글만 준다. 조회 횟수 제한은
 * 두지 않는다(명세).
 */
@Public()
@Controller('public-posts')
export class PublicPostsController {
  constructor(private readonly posts: PublishedPostsService) {}

  /** 상단 고정 먼저, 나머지는 게시일 내림차순. */
  @Get()
  list(
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(['GUEST'], query);
  }

  @Get(':postId')
  @ApiNotFoundResponse({
    description: '없음 · 비공개 · 지움 · 게시 기간 밖 · 비회원 대상 아님',
  })
  async get(@Param('postId') rawId: string): Promise<PublishedPostDto> {
    const postId = parseRouteId(rawId);
    if (postId === null)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    return this.posts.get(['GUEST'], postId);
  }
}
