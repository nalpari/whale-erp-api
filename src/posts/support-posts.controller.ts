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

/**
 * 관리자 웹 고객지원의 공지사항 · FAQ 화면 (WHALEERP-280 · 596). 로그인한 관리자가 노출 대상에 든 게시 글만 준다.
 * 관리자 웹은 메뉴 권한을 화면 경로로 판정하므로 글 종류마다 경로와 메뉴가 따로다 — 공지사항 `/support-notices`
 * (MN000035) · FAQ `/support-faqs`(MN000043). 그 메뉴의 조회 권한이 있으면 무엇이 보이는지는 노출 대상이 정한다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '관리자 토큰이 아니거나 사용 중인 관리자 계정이 아님 · 그 메뉴의 조회 권한 없음',
})
@UserTypes('admin')
abstract class SupportPostsController {
  protected abstract readonly contentType: PostContentType;
  protected abstract readonly menu: string;

  constructor(
    protected readonly posts: PublishedPostsService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    const audiences = await this.allow(user);
    return this.posts.list(audiences, this.contentType, query);
  }

  /** 메뉴 조회 권한을 본 뒤 그 관리자가 드는 노출 대상. 사용 중인 계정이 아니면 403 — 가드는 계정 상태를 보지 않는다. */
  protected async allow(user: AuthUser): Promise<Audiences> {
    await this.permissions.assert(user.id, this.menu, 'read');
    const audiences = await this.posts.audiencesOfAdmin(user.id);
    if (!audiences) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return audiences;
  }
}

/** 고객지원 공지사항 — 목록 · 상세(이전 · 다음, #282) · 첨부 내려받기. */
@Controller('support-notices')
export class SupportNoticesController extends SupportPostsController {
  protected readonly contentType = 'NOTICE';
  protected readonly menu = 'MN000035';

  /** 권한을 확인한 뒤에 이전 · 다음을 읽어 붙인다 — 권한 없는 사람에게 다른 글 제목을 읽지 않는다. */
  @Get(':postId')
  @ApiNotFoundResponse({
    description: '없음 · 비공개 · 지움 · 게시 기간 밖 · 노출 대상 아님 · FAQ',
  })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<SupportPostResponseDto> {
    const postId = parseRouteId(rawId);
    if (postId === null)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    const audiences = await this.allow(user);
    const post = await this.posts.get(audiences, this.contentType, postId);
    return { ...post, ...(await this.posts.neighbors(audiences, postId)) };
  }

  /** 첨부 내려받기 주소(#282). 그 관리자에게 보이는 공지사항(상세와 같은 판정)의 첨부가 아니면 404. */
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
    return this.posts.attachmentDownloadUrl(
      await this.allow(user),
      postId,
      attachmentId,
    );
  }
}

/** 고객지원 FAQ — 목록만. 펼쳐 읽어 상세 이동이 없다(목록이 답변 본문을 싣는다). */
@Controller('support-faqs')
export class SupportFaqsController extends SupportPostsController {
  protected readonly contentType = 'FAQ';
  protected readonly menu = 'MN000043';
}
