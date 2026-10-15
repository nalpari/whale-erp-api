import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import type { PostAudienceType } from '@prisma/client';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import {
  PublishedPostDto,
  PublishedPostListResponseDto,
} from './dto/published-post.response.dto';
import { PublishedPostsService } from './published-posts.service';

/**
 * 관리자 웹 고객지원의 공지사항 · FAQ 탭 (WHALEERP-280). 로그인한 관리자가 노출 대상에 든 게시 글만 준다.
 * FAQ 는 LNB 메뉴 없이 탭으로만 들어가므로 메뉴 권한을 보지 않는다(운영 정책 CNT-07).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '사용 중인 관리자 계정이 아님' })
@UserTypes('admin')
@Controller('support-posts')
export class SupportPostsController {
  constructor(private readonly posts: PublishedPostsService) {}

  /** 상단 고정 먼저, 나머지는 게시일 내림차순. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(await this.audiencesOf(user), query);
  }

  @Get(':postId')
  @ApiNotFoundResponse({
    description: '없음 · 비공개 · 지움 · 게시 기간 밖 · 노출 대상 아님',
  })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<PublishedPostDto> {
    const postId = parseRouteId(rawId);
    if (postId === null)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    return this.posts.get(await this.audiencesOf(user), postId);
  }

  private async audiencesOf(user: AuthUser): Promise<PostAudienceType[]> {
    const audiences = await this.posts.audiencesOfAdmin(user.id);
    if (!audiences) throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return audiences;
  }
}
