import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostListResponseDto, PostResponseDto } from './dto/post.response.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { PostsService } from './posts.service';

const MAX_ID = 2_147_483_647;

/**
 * 커뮤니티 관리 — 공지사항 · FAQ (WHALEERP-272 · 273 · 332). 관리자 웹의 플랫폼 관리자(PM · PA)만 쓴다.
 * 고객지원 · 비로그인 홈의 조회(WHALEERP-280)는 다른 경로다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '플랫폼 관리자가 아님' })
@UserTypes('admin')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 공지사항 또는 FAQ 목록. 최근 수정일 내림차순. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPostsDto,
  ): Promise<PostListResponseDto> {
    await this.assertPlatformAdmin(user);
    return this.posts.list(query);
  }

  @Get(':postId')
  @ApiNotFoundResponse({ description: '없거나 지운 게시물' })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<PostResponseDto> {
    const postId = await this.postIdOf(user, rawId);
    return this.posts.get(postId);
  }

  /** 등록. 임시저장 · 게시 · 비공개 어느 상태로든 만든다. 게시하려면 노출 대상이 있어야 한다. */
  @Post()
  @ApiBadRequestResponse({
    description:
      '노출 대상 없이 게시 · 공지사항 유형 없음 · FAQ 카테고리 없음 · 게시 종료일이 시작일보다 앞섬',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePostDto,
  ): Promise<PostResponseDto> {
    await this.assertPlatformAdmin(user);
    return this.posts.create(user.id, body);
  }

  /**
   * 수정. 게시 상태 · 상단 고정 · 노출 대상도 이 요청으로 바꾼다. 게시된 글이면 바로 사용자에게 보인다.
   * 읽은 뒤 다른 관리자가 고쳤으면 409 — 다시 읽어 최신 내용을 본다.
   */
  @Put(':postId')
  @ApiNotFoundResponse({ description: '없거나 지운 게시물' })
  @ApiBadRequestResponse({ description: '등록과 같음' })
  @ApiConflictResponse({ description: '그사이 다른 관리자가 고침' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
    @Body() body: UpdatePostDto,
  ): Promise<PostResponseDto> {
    const postId = await this.postIdOf(user, rawId);
    return this.posts.update(user.id, postId, body);
  }

  /** 지운다(지움 표시). 사용자에게 보이지 않고 행은 남는다. */
  @Delete(':postId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 게시물' })
  @ApiConflictResponse({ description: '이미 지운 게시물' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<void> {
    const postId = await this.postIdOf(user, rawId);
    await this.posts.remove(user.id, postId);
  }

  private async assertPlatformAdmin(user: AuthUser): Promise<void> {
    if (!(await this.scope.isPlatformAdmin(user.id)))
      throw new ForbiddenException('플랫폼 관리자만 쓸 수 있습니다');
  }

  /**
   * 정수 범위 밖이면 DB 에 묻기 전에 404 — 그대로 보내면 PostgreSQL 오류로 500 이 된다. 권한 확인보다 먼저라
   * 범위 밖 ID 는 누구에게나 404 다(모양만 보므로 드러나는 것은 없다).
   */
  private async postIdOf(user: AuthUser, rawId: string): Promise<number> {
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID)
      throw new NotFoundException('게시물을 찾을 수 없습니다');
    await this.assertPlatformAdmin(user);
    return id;
  }
}
