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
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import type { PostContentType } from '@prisma/client';
import { parseRouteId } from '../common/route-id';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
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
 * 그래서 메뉴 권한을 보는 다른 관리자 웹 경로와 달리 `@MenuPermission` 가드를 쓰지 않는다 — 가드는 글을 읽기 전에 돌아 상세의 메뉴를
 * 알 수 없다(2026-10-20 1팀 결정). 가드로 맞추려면 메뉴마다 경로를 나눠야 하고, 그것은 3팀 · 프론트와 함께 정한다.
 * 공지사항 상세는 권한을 확인한 뒤에 이전 · 다음(#282)을 읽어 붙인다 — 권한 없는 사람에게 다른 글 제목을 읽지 않는다.
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

  /**
   * 공지사항 첨부 내려받기 주소(#282). 첨부는 공지사항에만 있으므로 공지사항(MN000035) 조회 권한을 먼저 본다.
   * 그 관리자에게 보이는 공지사항(상세와 같은 판정)의 첨부가 아니면 404.
   */
  @Get(':postId/attachments/:postAttachmentId/download-url')
  @ApiNotFoundResponse({
    description: '글이 보이지 않음(상세와 같음) · 그 글의 첨부가 아님',
  })
  @ApiServiceUnavailableResponse({ description: '첨부파일 저장소 설정 없음' })
  async attachmentDownloadUrl(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
    @Param('postAttachmentId') rawAttachmentId: string,
  ): Promise<DownloadUrlResponseDto> {
    const postId = parseRouteId(rawId);
    const attachmentId = parseRouteId(rawAttachmentId);
    if (postId === null || attachmentId === null)
      throw new NotFoundException('첨부파일을 찾을 수 없습니다');
    await this.permissions.assert(user.id, MENU.NOTICE, 'read');
    return this.posts.attachmentDownloadUrl(
      await this.audiencesOf(user),
      postId,
      attachmentId,
    );
  }

  private async audiencesOf(user: AuthUser): Promise<Audiences> {
    const audiences = await this.posts.audiencesOfAdmin(user.id);
    if (!audiences) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return audiences;
  }
}
