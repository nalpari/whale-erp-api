import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
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
import { ListTemplatesDto } from './dto/list-templates.dto';
import {
  CreateTemplateDto,
  SetTemplateActiveDto,
  TemplateVersionDto,
  UpdateTemplateDto,
} from './dto/save-template.dto';
import {
  TemplateDetailDto,
  TemplateListResponseDto,
} from './dto/template.response.dto';
import { NotificationTemplatesService } from './notification-templates.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';

const MAX_ID = 2_147_483_647;

/**
 * 알림 템플릿 관리(WHALEERP-572 · 573 · 581) — 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구. 관리자 웹의 플랫폼
 * 마스터 · 플랫폼 관리자만 쓴다. 지우는 길은 없고 사용 여부로 끈다(운영 정책 NTF-21).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '플랫폼 관리자가 아님' })
@UserTypes('admin')
@Controller('notification-templates')
export class NotificationTemplatesController {
  constructor(
    private readonly templates: NotificationTemplatesService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 채널 탭 하나의 목록. 템플릿 코드순 */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListTemplatesDto,
  ): Promise<TemplateListResponseDto> {
    await this.assertPlatformAdmin(user);
    return this.templates.list(query);
  }

  /** 상세 — 변수 목록과 변경 이력(최근 것부터) */
  @Get(':id')
  @ApiNotFoundResponse({ description: '없는 템플릿' })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<TemplateDetailDto> {
    return this.templates.get(await this.idOf(user, rawId));
  }

  /** 등록. 기본 문구가 없어 되돌리기는 없다 */
  @Post()
  @ApiBadRequestResponse({
    description:
      '채널별 필수 칸 · #{변수} · 글자 수 검사 — message 에 고칠 문장 목록',
  })
  @ApiConflictResponse({ description: '템플릿 코드가 겹침' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateTemplateDto,
  ): Promise<TemplateDetailDto> {
    await this.assertPlatformAdmin(user);
    return this.templates.create(user.id, body);
  }

  /** 수정 — 모든 칸(NOTIFY-10). 읽은 뒤 누가 고쳤으면 409 */
  @Put(':id')
  @ApiNotFoundResponse({ description: '없는 템플릿' })
  @ApiBadRequestResponse({ description: '등록과 같음' })
  @ApiConflictResponse({
    description: '그사이 다른 운영자가 고침 · 템플릿 코드가 겹침',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdateTemplateDto,
  ): Promise<TemplateDetailDto> {
    return this.templates.update(user.id, await this.idOf(user, rawId), body);
  }

  /** 기본 문구로 되돌리기 — 제목 · 본문 · 변수 목록(NOTIFY-18) */
  @Post(':id/restore')
  @HttpCode(200)
  @ApiNotFoundResponse({ description: '없는 템플릿' })
  @ApiConflictResponse({
    description:
      '등록한 템플릿이라 기본 문구가 없음 · 그사이 다른 운영자가 고침',
  })
  async restore(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: TemplateVersionDto,
  ): Promise<TemplateDetailDto> {
    return this.templates.restore(user.id, await this.idOf(user, rawId), body);
  }

  /** 사용 / 사용 안 함 */
  @Patch(':id/active')
  @ApiNotFoundResponse({ description: '없는 템플릿' })
  @ApiConflictResponse({ description: '그사이 다른 운영자가 고침' })
  async setActive(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: SetTemplateActiveDto,
  ): Promise<TemplateDetailDto> {
    return this.templates.setActive(
      user.id,
      await this.idOf(user, rawId),
      body,
    );
  }

  private async assertPlatformAdmin(user: AuthUser): Promise<void> {
    if (!(await this.scope.isPlatformAdmin(user.id)))
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
  }

  /** 정수 범위 밖이면 DB 에 묻기 전에 404. 권한 확인보다 먼저다(모양만 보므로 드러나는 것은 없다). */
  private async idOf(user: AuthUser, rawId: string): Promise<number> {
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID)
      throw new NotFoundException('알림 템플릿을 찾을 수 없습니다');
    await this.assertPlatformAdmin(user);
    return id;
  }
}
