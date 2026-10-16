import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { AttachmentFileType } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { AttachmentsInterceptor, assertUpload } from '../storage/upload-check';
import { CreateSupportInquiryDto } from './dto/create-support-inquiry.dto';
import { ListSupportInquiriesDto } from './dto/list-support-inquiries.dto';
import {
  CreatedSupportInquiryResponseDto,
  SupportInquiryListResponseDto,
  SupportInquiryResponseDto,
} from './dto/support-inquiry.response.dto';
import { SupportInquiriesService } from './support-inquiries.service';

/** multer 가 메모리로 받은 첨부 한 개 중 쓰는 칸 */
type InquiryFile = { originalname: string; buffer: Buffer; size: number };

/** 고객지원 문의하기 메뉴 (/support-inquiries, WHALEERP-596) */
const MENU = 'MN000036';
/** 문의당 첨부 개수 상한(운영 정책 CNT-18). 파일당 10MB 는 기본 상한이다. */
const MAX_ATTACHMENTS = 5;

/**
 * 관리자 웹 고객지원의 문의하기 (WHALEERP-281). 내 문의 조회는 조회 권한, 등록은 등록 권한으로 판정하고
 * (재영 결정 2026-10-15), 보이는 것은 본인이 등록한 문의뿐이다. 운영자 쪽 처리는 `/inquiries` 다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '관리자 토큰이 아니거나 사용 중인 관리자 계정이 아님 · 문의하기 메뉴 권한 없음',
})
@Controller('support-inquiries')
export class SupportInquiriesController {
  constructor(private readonly inquiries: SupportInquiriesService) {}

  /**
   * 문의 등록. 텍스트 칸과 첨부파일(`files`, 선택)을 multipart 한 번으로 받는다. 첨부는 JPG · PNG · PDF, 5개까지,
   * 파일당 10MB 이고 종류는 파일 내용으로 확인한다. 등록한 뒤에는 첨부를 더하거나 빼지 않는다.
   */
  @Post()
  @MenuPermission(MENU, 'create')
  @UseInterceptors(AttachmentsInterceptor('files', MAX_ATTACHMENTS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['inquiryCategoryCode', 'title', 'body'],
      properties: {
        inquiryCategoryCode: { type: 'string', example: 'STAFF_LABOR' },
        title: { type: 'string', maxLength: 200 },
        body: { type: 'string', maxLength: 20_000 },
        files: {
          type: 'array',
          maxItems: MAX_ATTACHMENTS,
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: CreatedSupportInquiryResponseDto })
  @ApiBadRequestResponse({
    description:
      '입력 오류 · 사용 중이 아닌 문의 유형 · 파일 종류 · 크기 · 개수',
  })
  @ApiConflictResponse({
    description: '5분 안에 제목 · 내용이 같은 문의를 이미 등록함',
  })
  @ApiServiceUnavailableResponse({
    description: '첨부가 있는데 저장소가 설정되지 않음 · 저장소 오류',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSupportInquiryDto,
    @UploadedFiles() files: InquiryFile[] | undefined,
  ): Promise<CreatedSupportInquiryResponseDto> {
    const allowed = Object.values(AttachmentFileType);
    const uploads = (files ?? []).map((f) => ({
      fileName: f.originalname,
      buffer: f.buffer,
      fileType: assertUpload(f, allowed),
      sizeBytes: f.size,
    }));
    return this.inquiries.create(user.id, body, uploads);
  }

  /** 내 문의 목록. 등록 최신순. */
  @Get()
  @MenuPermission(MENU, 'read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSupportInquiriesDto,
  ): Promise<SupportInquiryListResponseDto> {
    return this.inquiries.list(user.id, query);
  }

  /** 내 문의 상세 — 마지막 답변만 보인다(운영 정책 CNT-17). */
  @Get(':inquiryId')
  @MenuPermission(MENU, 'read')
  @ApiNotFoundResponse({ description: '없는 문의이거나 남의 문의' })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
  ): Promise<SupportInquiryResponseDto> {
    return this.inquiries.get(user.id, inquiryIdOf(rawId));
  }

  /** 첨부파일 내려받기 주소. 300초 동안 쓸 수 있는 서명 주소이고, 받으면 원래 파일 이름으로 저장된다. */
  @Get(':inquiryId/attachments/:inquiryAttachmentId/download-url')
  @MenuPermission(MENU, 'read')
  @ApiNotFoundResponse({
    description: '없는 문의 · 남의 문의 · 그 문의의 첨부가 아님',
  })
  @ApiServiceUnavailableResponse({ description: '첨부파일 저장소 설정 없음' })
  async attachmentDownloadUrl(
    @CurrentUser() user: AuthUser,
    @Param('inquiryId') rawId: string,
    @Param('inquiryAttachmentId') rawAttachmentId: string,
  ): Promise<DownloadUrlResponseDto> {
    const inquiryId = inquiryIdOf(rawId);
    const attachmentId = parseRouteId(rawAttachmentId);
    if (attachmentId === null)
      throw new NotFoundException('첨부파일을 찾을 수 없습니다');
    return this.inquiries.attachmentDownloadUrl(
      user.id,
      inquiryId,
      attachmentId,
    );
  }
}

function inquiryIdOf(rawId: string): number {
  const id = parseRouteId(rawId);
  if (id === null) throw new NotFoundException('문의를 찾을 수 없습니다');
  return id;
}
