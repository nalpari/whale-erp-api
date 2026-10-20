import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { AttachmentFileType } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import { MenuPermission } from '../auth/menu-permission.guard';
import { NO_NUL } from '../common/no-nul';
import { parseRouteId } from '../common/route-id';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { AttachmentsInterceptor, assertUpload } from '../storage/upload-check';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostListResponseDto, PostResponseDto } from './dto/post.response.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import {
  MAX_POST_ATTACHMENTS,
  PostsService,
  type PostUpload,
} from './posts.service';

/*
 * 커뮤니티 관리 — 공지사항 · FAQ (WHALEERP-272 · 273 · 332). 관리자 웹은 메뉴 권한을 화면 경로로 판정하므로 글 종류마다
 * 경로와 메뉴가 따로다 — 공지사항 `/platform-notices`(MN000219) · FAQ `/platform-faqs`(MN000220). 동작마다 그 메뉴의
 * 권한과 플랫폼 계정(플랫폼 BP 의 PM · PA)을 가드로 본다 — 가드는 인터셉터보다 먼저라 권한이 없으면 첨부를 받기 전에 403 이다.
 * 다른 종류의 글 ID 는 없는 글처럼 404 다. 고객지원(WHALEERP-280) · 비로그인 홈(292)의 조회는 `/support-*` · `/public-*` 다.
 */

const NOTICE_MENU = 'MN000219';
const FAQ_MENU = 'MN000220';
const FORBIDDEN = '플랫폼 관리자가 아님 · 그 메뉴의 그 동작 권한 없음';
const BAD_FIELDS = '노출 대상 없이 게시 · 게시 종료일이 시작일보다 앞섬';

/** multer 가 메모리로 받은 첨부 한 개 중 쓰는 칸 */
type UploadedPostFile = { originalname: string; buffer: Buffer; size: number };

/** multipart 본문의 첨부 칸. 텍스트 칸은 등록 · 수정 DTO 와 같다(배열은 같은 이름을 되풀이해 보낸다). */
const FILES_SCHEMA = {
  files: {
    type: 'array',
    maxItems: MAX_POST_ATTACHMENTS,
    items: { type: 'string', format: 'binary' },
    description: '첨부파일 — JPG · PNG · PDF, 5개 · 파일당 10MB',
  },
};

/** 공지사항 관리. 등록 · 수정은 JSON 이나, 첨부가 있으면 multipart(텍스트 칸 + `files`)로 보낸다. */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: FORBIDDEN })
@ApiExtraModels(CreatePostDto, UpdatePostDto)
@Controller('platform-notices')
export class PlatformNoticesController {
  constructor(private readonly posts: PostsService) {}

  /** 목록. 최근 수정일 내림차순. */
  @Get()
  @MenuPermission(NOTICE_MENU, 'read', { platformOnly: true })
  list(@Query() query: ListPostsDto): Promise<PostListResponseDto> {
    return this.posts.list('NOTICE', query);
  }

  @Get(':postId')
  @MenuPermission(NOTICE_MENU, 'read', { platformOnly: true })
  @ApiNotFoundResponse({ description: '없거나 지운 공지사항' })
  get(@Param('postId') rawId: string): Promise<PostResponseDto> {
    return this.posts.get('NOTICE', postIdOf(rawId));
  }

  /** 등록. 임시저장 · 게시 · 비공개 어느 상태로든 만든다. 게시하려면 노출 대상이 있어야 한다. */
  @Post()
  @MenuPermission(NOTICE_MENU, 'create', { platformOnly: true })
  @UseInterceptors(AttachmentsInterceptor('files', MAX_POST_ATTACHMENTS))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      allOf: [
        { $ref: getSchemaPath(CreatePostDto) },
        { type: 'object', properties: FILES_SCHEMA },
      ],
    },
  })
  @ApiBadRequestResponse({
    description: `${BAD_FIELDS} · 공지사항 유형 없음 · 파일 종류 · 크기 · 개수`,
  })
  @ApiServiceUnavailableResponse({
    description: '첨부가 있는데 저장소가 설정되지 않음 · 저장소 오류',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePostDto,
    @UploadedFiles() files: UploadedPostFile[] | undefined,
  ): Promise<PostResponseDto> {
    return this.posts.create(user.id, 'NOTICE', body, checkedUploads(files));
  }

  /**
   * 수정. 게시 상태 · 상단 고정 · 노출 대상 · 첨부도 이 요청으로 바꾼다. 게시된 글이면 바로 사용자에게 보인다.
   * 첨부는 `files` 로 더하고 `removeAttachmentIds` 로 뺀다 — 남는 것과 더한 것이 합쳐 5개까지다.
   * 읽은 뒤 다른 관리자가 고쳤으면 409 — 다시 읽어 최신 내용을 본다.
   */
  @Put(':postId')
  @MenuPermission(NOTICE_MENU, 'update', { platformOnly: true })
  @UseInterceptors(AttachmentsInterceptor('files', MAX_POST_ATTACHMENTS))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      allOf: [
        { $ref: getSchemaPath(UpdatePostDto) },
        { type: 'object', properties: FILES_SCHEMA },
      ],
    },
  })
  @ApiNotFoundResponse({ description: '없거나 지운 공지사항' })
  @ApiBadRequestResponse({
    description: '등록과 같음 · 그 공지의 첨부가 아닌 ID 를 뺌 · 합쳐 5개 넘음',
  })
  @ApiConflictResponse({ description: '그사이 다른 관리자가 고침' })
  @ApiServiceUnavailableResponse({
    description: '첨부가 있는데 저장소가 설정되지 않음 · 저장소 오류',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
    @Body() body: UpdatePostDto,
    @UploadedFiles() files: UploadedPostFile[] | undefined,
  ): Promise<PostResponseDto> {
    return this.posts.update(
      user.id,
      'NOTICE',
      postIdOf(rawId),
      body,
      checkedUploads(files),
    );
  }

  /** 지운다(지움 표시). 사용자에게 보이지 않고 행은 남는다. */
  @Delete(':postId')
  @MenuPermission(NOTICE_MENU, 'delete', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 공지사항' })
  @ApiConflictResponse({ description: '이미 지운 공지사항' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<void> {
    await this.posts.remove(user.id, 'NOTICE', postIdOf(rawId));
  }

  /** 첨부 내려받기 주소. 300초 동안 쓸 수 있는 서명 주소이고, 받으면 원래 파일 이름으로 저장된다. */
  @Get(':postId/attachments/:postAttachmentId/download-url')
  @MenuPermission(NOTICE_MENU, 'read', { platformOnly: true })
  @ApiNotFoundResponse({
    description: '없거나 지운 공지사항 · 그 글의 첨부가 아님 · 뺀 첨부',
  })
  @ApiServiceUnavailableResponse({ description: '첨부파일 저장소 설정 없음' })
  attachmentDownloadUrl(
    @Param('postId') rawId: string,
    @Param('postAttachmentId') rawAttachmentId: string,
  ): Promise<DownloadUrlResponseDto> {
    const postId = postIdOf(rawId);
    const attachmentId = parseRouteId(rawAttachmentId);
    if (attachmentId === null)
      throw new NotFoundException('첨부파일을 찾을 수 없습니다');
    return this.posts.attachmentDownloadUrl('NOTICE', postId, attachmentId);
  }
}

/** FAQ 관리. 첨부가 없어 등록 · 수정은 JSON 만 받는다. 공지사항 칸(유형 · 상단 고정 · 게시 기간)은 받아도 버린다. */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('platform-faqs')
export class PlatformFaqsController {
  constructor(private readonly posts: PostsService) {}

  /** 목록. 최근 수정일 내림차순. */
  @Get()
  @MenuPermission(FAQ_MENU, 'read', { platformOnly: true })
  list(@Query() query: ListPostsDto): Promise<PostListResponseDto> {
    return this.posts.list('FAQ', query);
  }

  @Get(':postId')
  @MenuPermission(FAQ_MENU, 'read', { platformOnly: true })
  @ApiNotFoundResponse({ description: '없거나 지운 FAQ' })
  get(@Param('postId') rawId: string): Promise<PostResponseDto> {
    return this.posts.get('FAQ', postIdOf(rawId));
  }

  /** 등록. 임시저장 · 게시 · 비공개 어느 상태로든 만든다. 게시하려면 노출 대상이 있어야 한다. */
  @Post()
  @MenuPermission(FAQ_MENU, 'create', { platformOnly: true })
  @ApiBadRequestResponse({ description: `${BAD_FIELDS} · FAQ 카테고리 없음` })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePostDto,
  ): Promise<PostResponseDto> {
    return this.posts.create(user.id, 'FAQ', body);
  }

  /** 수정. 게시된 글이면 바로 사용자에게 보인다. 읽은 뒤 다른 관리자가 고쳤으면 409 — 다시 읽어 최신 내용을 본다. */
  @Put(':postId')
  @MenuPermission(FAQ_MENU, 'update', { platformOnly: true })
  @ApiNotFoundResponse({ description: '없거나 지운 FAQ' })
  @ApiBadRequestResponse({ description: '등록과 같음 · 첨부 ID 를 뺌' })
  @ApiConflictResponse({ description: '그사이 다른 관리자가 고침' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
    @Body() body: UpdatePostDto,
  ): Promise<PostResponseDto> {
    return this.posts.update(user.id, 'FAQ', postIdOf(rawId), body);
  }

  /** 지운다(지움 표시). 사용자에게 보이지 않고 행은 남는다. */
  @Delete(':postId')
  @MenuPermission(FAQ_MENU, 'delete', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 FAQ' })
  @ApiConflictResponse({ description: '이미 지운 FAQ' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('postId') rawId: string,
  ): Promise<void> {
    await this.posts.remove(user.id, 'FAQ', postIdOf(rawId));
  }
}

/** 정수 범위 밖이면 DB 에 묻기 전에 404 — 그대로 보내면 PostgreSQL 오류로 500 이 된다. */
function postIdOf(rawId: string): number {
  const id = parseRouteId(rawId);
  if (id === null) throw new NotFoundException('게시물을 찾을 수 없습니다');
  return id;
}

/** 첨부를 내용으로 검사한다(종류 · 크기). 파일 이름은 그대로 text 칸에 저장하므로 NUL 이면 400 — 아니면 업로드 뒤 500 이다. */
function checkedUploads(files: UploadedPostFile[] | undefined): PostUpload[] {
  const allowed = Object.values(AttachmentFileType);
  if (files?.some((f) => !NO_NUL.test(f.originalname)))
    throw new BadRequestException('파일 이름에 쓸 수 없는 문자가 있습니다');
  return (files ?? []).map((f) => ({
    fileName: f.originalname,
    buffer: f.buffer,
    fileType: assertUpload(f, allowed),
    sizeBytes: f.size,
  }));
}
