import {
  Body,
  Controller,
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
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import { MenuPermission } from '../auth/menu-permission.guard';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { SaveInternalMemoDto } from '../common/save-internal-memo.dto';
import { parseRouteId } from '../common/route-id';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { CreateInquiryReplyDto } from './dto/create-inquiry-reply.dto';
import {
  InquiryListResponseDto,
  InquiryResponseDto,
} from './dto/inquiry.response.dto';
import { InquiryStateResponseDto } from './dto/inquiry-state.response.dto';
import { ListInquiriesDto } from './dto/list-inquiries.dto';
import { InquiriesService } from './inquiries.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';

/** 커뮤니티 관리 문의사항 메뉴. 관리자 웹 화면 주소와 같은 `/platform-inquiries` 다. */
const MENU = 'MN000221';

/**
 * 커뮤니티 관리 — 문의사항 목록 · 상세(WHALEERP-332)와 처리(WHALEERP-274). 문의사항 메뉴(MN000221)의 권한(조회 ·
 * 수정 — 처리 · 답변 · 메모는 수정)을 가진 플랫폼 관리자(PM · PA)만 쓴다. 고객지원의 등록 · 조회(#281)는
 * `/support-inquiries` 다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '플랫폼 관리자가 아님 · 그 메뉴의 그 동작 권한 없음',
})
@ApiNotFoundResponse({ description: '없는 문의' })
@UserTypes('admin')
@Controller('platform-inquiries')
export class InquiriesController {
  constructor(
    private readonly inquiries: InquiriesService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 문의사항 목록. 접수 최신순. */
  @Get()
  @MenuPermission(MENU, 'read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListInquiriesDto,
  ): Promise<InquiryListResponseDto> {
    await this.assertPlatformAdmin(user);
    return this.inquiries.list(query);
  }

  /** 문의사항 상세 — 답변 이력 · 첨부파일 · 처리 이력 · 내부 메모. */
  @Get(':inquiryId')
  @MenuPermission(MENU, 'read')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
  ): Promise<InquiryResponseDto> {
    return this.inquiries.get(await this.inquiryIdOf(user, rawId));
  }

  /**
   * 첨부파일 내려받기 주소. 300초 동안 쓸 수 있는 서명 주소이고, 받으면 원래 파일 이름으로 저장된다. 저장소 설정이 없는
   * 환경이면 503.
   */
  @Get(':inquiryId/attachments/:inquiryAttachmentId/download-url')
  @ApiNotFoundResponse({ description: '없는 문의이거나 그 문의의 첨부가 아님' })
  @ApiServiceUnavailableResponse({ description: '첨부파일 저장소 설정 없음' })
  @MenuPermission(MENU, 'read')
  async attachmentDownloadUrl(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
    @Param('inquiryAttachmentId') rawAttachmentId: string,
  ): Promise<DownloadUrlResponseDto> {
    const attachmentId = parseRouteId(rawAttachmentId);
    if (attachmentId === null)
      throw new NotFoundException('첨부파일을 찾을 수 없습니다');
    const inquiryId = await this.inquiryIdOf(user, rawId);
    return this.inquiries.attachmentDownloadUrl(inquiryId, attachmentId);
  }

  /** 처리중으로 바꾼다. 접수 상태에서만 된다. */
  @Post(':inquiryId/processing')
  @HttpCode(HttpStatus.OK)
  @ApiConflictResponse({ description: '이미 처리중이거나 답변한 문의' })
  @MenuPermission(MENU, 'update')
  async startProcessing(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
  ): Promise<InquiryStateResponseDto> {
    const inquiryId = await this.inquiryIdOf(user, rawId);
    return this.inquiries.startProcessing(user.id, inquiryId);
  }

  /**
   * 답변을 저장하고 답변 완료로 바꾼다. 답변을 고칠 때도 이것으로 새 답변을 더한다. 첫 답변이면 등록한 관리자에게
   * 운영 알림과 메일이 간다.
   */
  @Post(':inquiryId/replies')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  @MenuPermission(MENU, 'update')
  async reply(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
    @Body() body: CreateInquiryReplyDto,
  ): Promise<InquiryStateResponseDto> {
    const inquiryId = await this.inquiryIdOf(user, rawId);
    return this.inquiries.reply(user.id, inquiryId, body);
  }

  /** 운영자 내부 메모. 문의자에게 보이지 않는다. */
  @Put(':inquiryId/internal-memo')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  @MenuPermission(MENU, 'update')
  async saveInternalMemo(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
    @Body() body: SaveInternalMemoDto,
  ): Promise<InquiryStateResponseDto> {
    const inquiryId = await this.inquiryIdOf(user, rawId);
    return this.inquiries.saveInternalMemo(inquiryId, body);
  }

  /** 범위 밖 ID 는 권한 확인보다 먼저 404 다(모양만 보므로 드러나는 것은 없다). */
  private async inquiryIdOf(user: AuthUser, rawId: string): Promise<number> {
    const id = parseRouteId(rawId);
    if (id === null) throw new NotFoundException('문의를 찾을 수 없습니다');
    await this.assertPlatformAdmin(user);
    return id;
  }

  private async assertPlatformAdmin(user: AuthUser): Promise<void> {
    if (!(await this.scope.isPlatformAdmin(user.id)))
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
  }
}
