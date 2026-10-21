import {
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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import { MenuPermission } from '../auth/menu-permission.guard';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { SaveInternalMemoDto } from '../common/save-internal-memo.dto';
import { parseRouteId } from '../common/route-id';
import { LeadListResponseDto, LeadResponseDto } from './dto/lead.response.dto';
import { LeadReplyMailResponseDto } from './dto/lead-reply-mail.response.dto';
import { LeadStateResponseDto } from './dto/lead-state.response.dto';
import { ListLeadsDto } from './dto/list-leads.dto';
import { SaveLeadReplyDto } from './dto/save-lead-reply.dto';
import { LeadsAdminService } from './leads-admin.service';

/** 커뮤니티 관리 도입문의 메뉴. 관리자 웹 화면 주소와 같은 `/platform-leads` 다. */
/** 메뉴 권한에 더해 플랫폼 BP 의 PM · PA 여야 한다(가드가 본다). */
const PLATFORM = { platformOnly: true };
const MENU = 'MN000222';

/**
 * 커뮤니티 관리 — 도입문의 목록 · 상세(WHALEERP-332), 처리(WHALEERP-274), 지우기(WHALEERP-590), 답변 메일 다시 보내기
 * (WHALEERP-597). 도입문의 메뉴(MN000222)의 권한(조회 · 수정 · 삭제 — 처리 · 답변 · 다시 보내기 · 메모는 수정)을 가진
 * 플랫폼 관리자(PM · PA)만 쓴다. 로그인 없이 받는 접수는 `POST /leads`(LeadsController)다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '플랫폼 관리자가 아님 · 그 메뉴의 그 동작 권한 없음',
})
@ApiNotFoundResponse({ description: '없는 도입문의' })
@UserTypes('admin')
@Controller('platform-leads')
export class LeadsAdminController {
  constructor(private readonly leads: LeadsAdminService) {}

  /** 도입문의 목록. 접수 최신순. */
  @Get()
  @MenuPermission(MENU, 'read', PLATFORM)
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListLeadsDto,
  ): Promise<LeadListResponseDto> {
    return this.leads.list(query);
  }

  /** 도입문의 상세 — 문의자 정보 · 동의 · 답변 · 처리 이력 · 내부 메모. */
  @Get(':leadId')
  @MenuPermission(MENU, 'read', PLATFORM)
  async get(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<LeadResponseDto> {
    return this.leads.get(leadIdOf(rawId));
  }

  /** 처리중으로 바꾼다. 접수 상태에서만 된다. */
  @Post(':leadId/processing')
  @HttpCode(HttpStatus.OK)
  @ApiConflictResponse({ description: '이미 처리중이거나 답변한 도입문의' })
  @MenuPermission(MENU, 'update', PLATFORM)
  async startProcessing(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<LeadStateResponseDto> {
    const leadId = leadIdOf(rawId);
    return this.leads.startProcessing(user.id, leadId);
  }

  /** 답변을 저장하고 답변 완료로 바꾼다. 고칠 때도 이것으로 덮어쓴다. */
  @Put(':leadId/reply')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  @MenuPermission(MENU, 'update', PLATFORM)
  async reply(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
    @Body() body: SaveLeadReplyDto,
  ): Promise<LeadStateResponseDto> {
    const leadId = leadIdOf(rawId);
    return this.leads.reply(user.id, leadId, body);
  }

  /**
   * 저장된 지금 답변을 문의자 이메일로 다시 보낸다. 답변완료만, 같은 도입문의는 1분에 한 번. SMTP 가 실패해도 200 이고
   * 결과(`FAILED`)를 돌려준다 — 상세의 마지막 발송 결과에도 보통 같은 값이 남는다. 메일 발송 설정이 없으면 503.
   */
  @Post(':leadId/reply-mail/resend')
  @HttpCode(HttpStatus.OK)
  @ApiConflictResponse({
    description: '답변완료가 아니거나, 1분 안에 이미 보냄',
  })
  @ApiServiceUnavailableResponse({ description: '메일 발송 설정(MAIL_*) 없음' })
  @MenuPermission(MENU, 'update', PLATFORM)
  async resendReplyMail(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<LeadReplyMailResponseDto> {
    const leadId = leadIdOf(rawId);
    return this.leads.resendReplyMail(user.id, leadId);
  }

  /** 운영자 내부 메모. 문의자에게 보이지 않는다. */
  @Put(':leadId/internal-memo')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  @MenuPermission(MENU, 'update', PLATFORM)
  async saveInternalMemo(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
    @Body() body: SaveInternalMemoDto,
  ): Promise<LeadStateResponseDto> {
    const leadId = leadIdOf(rawId);
    return this.leads.saveInternalMemo(leadId, body);
  }

  /** 상담하지 않은(상담 완료일 없는) 도입문의를 지운다. 행을 남기지 않는다(개인정보 파기, CNT-11). */
  @Delete(':leadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '지움' })
  @ApiConflictResponse({ description: '상담을 마친 도입문의' })
  @MenuPermission(MENU, 'delete', PLATFORM)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<void> {
    const leadId = leadIdOf(rawId);
    await this.leads.remove(user.id, leadId);
  }
}

/** 정수 범위 밖이면 DB 에 묻기 전에 404 — 그대로 보내면 PostgreSQL 오류로 500 이 된다. 권한 가드 뒤라 권한이 없으면 403 이다. */
function leadIdOf(rawId: string): number {
  const id = parseRouteId(rawId);
  if (id === null) throw new NotFoundException('도입문의를 찾을 수 없습니다');
  return id;
}
