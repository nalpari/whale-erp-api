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
import type { PostContentType } from '@prisma/client';
import { parseRouteId } from '../common/route-id';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import {
  PublishedPostListResponseDto,
  SupportPostResponseDto,
} from './dto/published-post.response.dto';
import {
  type Audiences,
  PublishedPostsService,
} from './published-posts.service';

/** 고객지원 메뉴 — 공지사항 /support-notices · FAQ /support-faqs (WHALEERP-596). */
const MENU: Record<PostContentType, string> = {
  NOTICE: 'MN000035',
  FAQ: 'MN000043',
};

/**
 * 관리자 웹 고객지원의 공지사항 · FAQ 화면 (WHALEERP-280). 로그인한 관리자가 노출 대상에 든 게시 글만 준다.
 * 한 경로가 두 종류를 주므로 글 종류마다 그 메뉴의 조회 권한으로 판정한다(재영 결정 2026-10-15) — 목록은
 * 요청의 `contentType` 으로 목록을 읽기 전에, 상세는 글을 읽어 종류를 안 뒤에. 권한이 있으면 무엇이 보이는지는 노출 대상이 정한다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '관리자 토큰이 아니거나 사용 중인 관리자 계정이 아님 · 그 글 종류 메뉴의 조회 권한 없음',
})
@UserTypes('admin')
@Controller('support-posts')
export class SupportPostsController {
  constructor(
    private readonly posts: PublishedPostsService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    await this.permissions.assert(user.id, MENU[query.contentType], 'read');
    return this.posts.list(await this.audiencesOf(user), query);
  }

  @Get(':postId')
  @ApiNotFoundResponse({
    description: '없음 · 비공개 · 지움 · 게시 기간 밖 · 노출 대상 아님',
  })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<SupportPostResponseDto> {
    const postId = parseRouteId(rawId);
    if (postId === null)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    const audiences = await this.audiencesOf(user);
    const post = await this.posts.get(audiences, postId);
    await this.permissions.assert(user.id, MENU[post.contentType], 'read');
    const neighbors =
      post.contentType === 'NOTICE'
        ? await this.posts.neighbors(audiences, postId)
        : { prev: null, next: null };
    return { ...post, ...neighbors };
  }

  private async audiencesOf(user: AuthUser): Promise<Audiences> {
    const audiences = await this.posts.audiencesOfAdmin(user.id);
    if (!audiences) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return audiences;
  }
}
