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
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import {
  PublishedPostResponseDto,
  PublishedPostListResponseDto,
} from './dto/published-post.response.dto';
import {
  type Audiences,
  PublishedPostsService,
} from './published-posts.service';

/**
 * 관리자 웹 고객지원의 공지사항(MN000035 `/support-notices`) · FAQ(MN000043 `/support-faqs`) 화면 (WHALEERP-280).
 * 두 화면은 따로 된 메뉴다(WHALEERP-596, 2026-10-15). 로그인한 관리자가 노출 대상에 든 게시 글만 준다.
 * 메뉴 권한은 보지 않는다 — 로그인한 관리자는 누구나 고객지원을 쓰고, 무엇이 보이는지는 노출 대상이 정한다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '관리자 토큰이 아니거나 사용 중인 관리자 계정이 아님',
})
@UserTypes('admin')
@Controller('support-posts')
export class SupportPostsController {
  constructor(private readonly posts: PublishedPostsService) {}

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
  ): Promise<PublishedPostResponseDto> {
    const postId = parseRouteId(rawId);
    if (postId === null)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    return this.posts.get(await this.audiencesOf(user), postId);
  }

  private async audiencesOf(user: AuthUser): Promise<Audiences> {
    const audiences = await this.posts.audiencesOfAdmin(user.id);
    if (!audiences) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return audiences;
  }
}
