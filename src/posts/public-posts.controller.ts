import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { parseRouteId } from '../common/route-id';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import {
  PublishedPostDetailResponseDto,
  PublishedPostListResponseDto,
} from './dto/published-post.response.dto';
import { PublishedPostsService } from './published-posts.service';

/*
 * 비로그인 홈의 공지사항 · FAQ (WHALEERP-292). 노출 대상에 비회원이 든 게시 글만 준다. 요청 횟수 제한(throttle)은
 * 걸지 않는다(명세). 경로는 관리 · 고객지원처럼 글 종류마다 따로다 — `/public-notices` · `/public-faqs`.
 */

/** 비로그인 공지사항 — 목록 · 상세 · 첨부 내려받기. */
@Public()
@Controller('public-notices')
export class PublicNoticesController {
  constructor(private readonly posts: PublishedPostsService) {}

  @Get()
  list(
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(['GUEST'], 'NOTICE', query);
  }

  @Get(':postId')
  @ApiNotFoundResponse({
    description: '없음 · 비공개 · 지움 · 게시 기간 밖 · 비회원 대상 아님 · FAQ',
  })
  async get(
    @Param('postId') rawId: string,
  ): Promise<PublishedPostDetailResponseDto> {
    return this.posts.get(
      ['GUEST'],
      'NOTICE',
      idOf(rawId, '게시물을 찾을 수 없습니다'),
    );
  }

  /** 첨부 내려받기 주소. 300초 동안 쓸 수 있고, 받으면 원래 파일 이름으로 저장된다. */
  @Get(':postId/attachments/:postAttachmentId/download-url')
  @ApiNotFoundResponse({
    description:
      '글이 비회원에게 보이지 않음(상세와 같음) · 그 글의 첨부가 아님',
  })
  @ApiServiceUnavailableResponse({ description: '첨부파일 저장소 설정 없음' })
  async attachmentDownloadUrl(
    @Param('postId') rawId: string,
    @Param('postAttachmentId') rawAttachmentId: string,
  ): Promise<DownloadUrlResponseDto> {
    const postId = idOf(rawId, '게시물을 찾을 수 없습니다');
    const attachmentId = idOf(rawAttachmentId, '첨부파일을 찾을 수 없습니다');
    return this.posts.attachmentDownloadUrl(['GUEST'], postId, attachmentId);
  }
}

/** 비로그인 FAQ — 목록만. 펼쳐 읽어 상세 이동이 없다(목록이 답변 본문을 싣는다). */
@Public()
@Controller('public-faqs')
export class PublicFaqsController {
  constructor(private readonly posts: PublishedPostsService) {}

  @Get()
  list(
    @Query() query: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    return this.posts.list(['GUEST'], 'FAQ', query);
  }
}

/** 정수 범위 밖이면 DB 에 묻기 전에 404 — 그대로 보내면 PostgreSQL 오류로 500 이 된다. */
function idOf(raw: string, message: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(message);
  return id;
}
