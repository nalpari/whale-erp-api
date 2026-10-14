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
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { SaveInternalMemoDto } from '../common/save-internal-memo.dto';
import { parseRouteId } from '../common/route-id';
import { LeadListResponseDto, LeadResponseDto } from './dto/lead.response.dto';
import { LeadStateResponseDto } from './dto/lead-state.response.dto';
import { ListLeadsDto } from './dto/list-leads.dto';
import { SaveLeadReplyDto } from './dto/save-lead-reply.dto';
import { LeadsAdminService } from './leads-admin.service';

/**
 * 커뮤니티 관리 — 도입문의 목록 · 상세(WHALEERP-332)와 처리(WHALEERP-274). 관리자 웹의 플랫폼 관리자(PM · PA)만
 * 쓴다.
 * 같은 `/leads` 의 접수(LeadsController)는 로그인 없이 받는 공개 경로라, 이 경로들은 컨트롤러를 나눠 @Public 과
 * 접수 요청 한도를 물려받지 않게 한다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '플랫폼 관리자가 아님' })
@ApiNotFoundResponse({ description: '없는 도입문의' })
@UserTypes('admin')
@Controller('leads')
export class LeadsAdminController {
  constructor(
    private readonly leads: LeadsAdminService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 도입문의 목록. 접수 최신순. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListLeadsDto,
  ): Promise<LeadListResponseDto> {
    await this.assertPlatformAdmin(user);
    return this.leads.list(query);
  }

  /** 도입문의 상세 — 문의자 정보 · 동의 · 답변 · 처리 이력 · 내부 메모. */
  @Get(':leadId')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<LeadResponseDto> {
    return this.leads.get(await this.leadIdOf(user, rawId));
  }

  /** 처리중으로 바꾼다. 접수 상태에서만 된다. */
  @Post(':leadId/processing')
  @HttpCode(HttpStatus.OK)
  @ApiConflictResponse({ description: '이미 처리중이거나 답변한 도입문의' })
  async startProcessing(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
  ): Promise<LeadStateResponseDto> {
    const leadId = await this.leadIdOf(user, rawId);
    return this.leads.startProcessing(user.id, leadId);
  }

  /** 답변을 저장하고 답변 완료로 바꾼다. 고칠 때도 이것으로 덮어쓴다. */
  @Put(':leadId/reply')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  async reply(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
    @Body() body: SaveLeadReplyDto,
  ): Promise<LeadStateResponseDto> {
    const leadId = await this.leadIdOf(user, rawId);
    return this.leads.reply(user.id, leadId, body);
  }

  /** 운영자 내부 메모. 문의자에게 보이지 않는다. */
  @Put(':leadId/internal-memo')
  @ApiConflictResponse({ description: '그사이 다른 운영자가 저장함' })
  async saveInternalMemo(
    @CurrentUser() user: AuthUser,
    @Param('leadId') rawId: string,
    @Body() body: SaveInternalMemoDto,
  ): Promise<LeadStateResponseDto> {
    const leadId = await this.leadIdOf(user, rawId);
    return this.leads.saveInternalMemo(leadId, body);
  }

  /** 범위 밖 ID 는 권한 확인보다 먼저 404 다(모양만 보므로 드러나는 것은 없다). */
  private async leadIdOf(user: AuthUser, rawId: string): Promise<number> {
    const id = parseRouteId(rawId);
    if (id === null) throw new NotFoundException('도입문의를 찾을 수 없습니다');
    await this.assertPlatformAdmin(user);
    return id;
  }

  private async assertPlatformAdmin(user: AuthUser): Promise<void> {
    if (!(await this.scope.isPlatformAdmin(user.id)))
      throw new ForbiddenException('플랫폼 관리자만 쓸 수 있습니다');
  }
}
