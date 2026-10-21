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
import { CurrentUser } from '../auth/auth.decorators';
import { MenuPermission } from '../auth/menu-permission.guard';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
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

/*
 * 관리자 웹 고객지원의 공지사항 · FAQ 화면 (WHALEERP-280 · 596). 로그인한 관리자가 노출 대상에 든 게시 글만 준다.
 * 관리자 웹은 메뉴 권한을 화면 경로로 판정하므로 글 종류마다 경로와 메뉴가 따로다 — 공지사항 `/support-notices`
 * (MN000035) · FAQ `/support-faqs`(MN000043). 경로가 메뉴를 정하므로 다른 관리자 웹 화면처럼 `@MenuPermission` 가드가
 * 글을 읽기 전에 그 메뉴의 조회 권한을 본다. 권한이 있으면 무엇이 보이는지는 노출 대상이 정한다.
 */

const FORBIDDEN =
  '관리자 토큰이 아니거나 사용 중인 관리자 계정이 아님 · 그 메뉴의 조회 권한 없음';

/** 고객지원 공지사항 — 목록 · 상세(이전 · 다음, #282) · 첨부 내려받기. */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('support-notices')
export class SupportNoticesController {
  constructor(private readonly posts: PublishedPostsService) {}

  @Get()
  @MenuPermission('read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(
      await audiencesOf(this.posts, user),
      'NOTICE',
      query,
    );
  }

  /** 가드가 권한을 본 뒤에 이전 · 다음을 읽어 붙인다 — 권한 없는 사람에게 다른 글 제목을 읽지 않는다. */
  @Get(':postId')
  @MenuPermission('read')
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
    const audiences = await audiencesOf(this.posts, user);
    const post = await this.posts.get(audiences, 'NOTICE', postId);
    return { ...post, ...(await this.posts.neighbors(audiences, postId)) };
  }

  /** 첨부 내려받기 주소(#282). 그 관리자에게 보이는 공지사항(상세와 같은 판정)의 첨부가 아니면 404. */
  @Get(':postId/attachments/:postAttachmentId/download-url')
  @MenuPermission('read')
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
      await audiencesOf(this.posts, user),
      postId,
      attachmentId,
    );
  }
}

/** 고객지원 FAQ — 목록만. 펼쳐 읽어 상세 이동이 없다(목록이 답변 본문을 싣는다). */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('support-faqs')
export class SupportFaqsController {
  constructor(private readonly posts: PublishedPostsService) {}

  @Get()
  @MenuPermission('read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(await audiencesOf(this.posts, user), 'FAQ', query);
  }
}

/** 그 관리자가 드는 노출 대상. 가드가 사용 중 계정을 봤지만 그 사이 막혔으면 403 이다. */
async function audiencesOf(
  posts: PublishedPostsService,
  user: AuthUser,
): Promise<Audiences> {
  const audiences = await posts.audiencesOfAdmin(user.id);
  if (!audiences) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
  return audiences;
}
