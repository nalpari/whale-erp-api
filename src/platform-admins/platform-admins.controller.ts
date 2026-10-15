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
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  type MenuAction,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { ListPlatformAdminsDto, PageDto } from './dto/list-platform-admins.dto';
import {
  LoginIdAvailabilityQueryDto,
  LoginIdAvailabilityResponseDto,
} from './dto/login-id-availability.dto';
import {
  CreatePlatformAdminResponseDto,
  PlatformAdminDetailResponseDto,
  PlatformAdminHistoryListResponseDto,
  PlatformAdminListResponseDto,
  PlatformRoleGroupListResponseDto,
  ResetPasswordResponseDto,
} from './dto/platform-admin.response.dto';
import {
  CreatePlatformAdminDto,
  UpdatePlatformAdminDto,
} from './dto/save-platform-admin.dto';
import { INT4_MAX } from './platform-admin-format';
import { PlatformAdminsService } from './platform-admins.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';

/** 메뉴 「플랫폼 관리자 관리」(/platform/system/admins) */
const MENU = 'MN000213';

/**
 * 플랫폼 관리자 관리. 관리자 웹의 메뉴 권한(조회 · 등록 · 수정 · 삭제)으로 동작마다 판정한다 —
 * 마스터 보호 · 본인 보호는 서비스가 본다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '메뉴 권한 없음 · 플랫폼 계정이 아님 · 마스터 보호 · 본인 보호',
})
@UserTypes('admin')
@Controller('platform-admins')
export class PlatformAdminsController {
  constructor(
    private readonly admins: PlatformAdminsService,
    private readonly permissions: MenuPermissionsService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 목록. 지우지 않은 플랫폼 마스터 · 플랫폼 관리자, 등록일시 최신순. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPlatformAdminsDto,
  ): Promise<PlatformAdminListResponseDto> {
    await this.allow(user, 'read');
    return this.admins.list(query);
  }

  /** 사용자 권한 선택지. 플랫폼 관리자에게는 플랫폼 마스터 권한을 빼고 준다. */
  @Get('role-groups')
  async roleGroups(
    @CurrentUser() user: AuthUser,
  ): Promise<PlatformRoleGroupListResponseDto> {
    return this.admins.roleGroups(await this.allow(user, 'read'));
  }

  /**
   * 아이디 중복 확인. 등록 화면이 칸을 벗어나거나 Enter 를 칠 때 묻는다. 등록 권한이 필요하다.
   * `:id` 보다 먼저 둔다 — 뒤에 두면 이 경로가 상세(:id)로 잡힌다.
   */
  @Get('login-id-availability')
  @ApiBadRequestResponse({ description: '아이디 형식' })
  async loginIdAvailability(
    @CurrentUser() user: AuthUser,
    @Query() query: LoginIdAvailabilityQueryDto,
  ): Promise<LoginIdAvailabilityResponseDto> {
    await this.allow(user, 'create');
    return {
      available: await this.admins.isLoginIdAvailable(query.loginId),
    };
  }

  /** 상세. 지운 · 탈퇴한 계정과 BP 쪽 계정은 404. */
  @Get(':id')
  @ApiNotFoundResponse({
    description: '없거나 지운 · 탈퇴한 계정, 플랫폼 관리자가 아닌 계정',
  })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PlatformAdminDetailResponseDto> {
    const id = idOf(rawId);
    await this.allow(user, 'read');
    return this.admins.detail(id);
  }

  /** 생성 · 변경 이력. 최신순. */
  @Get(':id/histories')
  @ApiNotFoundResponse({
    description: '없거나 지운 · 탈퇴한 계정, 플랫폼 관리자가 아닌 계정',
  })
  async histories(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: PageDto,
  ): Promise<PlatformAdminHistoryListResponseDto> {
    const id = idOf(rawId);
    await this.allow(user, 'read');
    return this.admins.histories(id, query);
  }

  /** 등록. 늘 사용으로 만들고 1시간짜리 초기 비밀번호를 메일로만 보낸다. */
  @Post()
  @ApiBadRequestResponse({ description: '입력 형식 · 줄 수 없는 권한' })
  @ApiConflictResponse({ description: '아이디 · 이메일 중복' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePlatformAdminDto,
  ): Promise<CreatePlatformAdminResponseDto> {
    return this.admins.create(await this.allow(user, 'create'), body);
  }

  /** 수정. 상세에서 받은 updatedAt 을 함께 보낸다 — 그 사이 다른 사람이 고쳤으면 409. */
  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({
    description: '없거나 지운 · 탈퇴한 계정, 플랫폼 관리자가 아닌 계정',
  })
  @ApiConflictResponse({
    description: '이메일 중복 · 동시 수정 · 마지막 사용 중 플랫폼 마스터',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdatePlatformAdminDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.admins.update(await this.allow(user, 'update'), id, body);
  }

  /** 계정 삭제(논리 삭제). 되살리지 않는다. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({
    description: '없거나 지운 · 탈퇴한 계정, 플랫폼 관리자가 아닌 계정',
  })
  @ApiConflictResponse({
    description:
      '마지막 사용 중 플랫폼 마스터 · 그 사이 다른 관리자가 지우거나 권한 유형을 바꿈',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.admins.remove(await this.allow(user, 'delete'), id);
  }

  /**
   * 비밀번호 초기화. 새 1시간짜리 초기 비밀번호를 그 계정 이메일로만 보낸다. 수정 권한이 필요하다.
   * 응답의 updatedAt 으로 다음 수정을 저장한다 — 초기화가 그 값을 올린다.
   */
  @Post(':id/password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({
    description: '없거나 지운 · 탈퇴한 계정, 플랫폼 관리자가 아닌 계정',
  })
  @ApiConflictResponse({
    description:
      '이메일이 없는 계정 · 그 사이 다른 관리자가 지우거나 권한 유형 · 이메일을 바꿈',
  })
  @ApiServiceUnavailableResponse({
    description:
      '메일 설정(MAIL_* · ADMIN_WEB_URL)이 없는 환경 — 아무것도 바꾸지 않는다',
  })
  async resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<ResetPasswordResponseDto> {
    const id = idOf(rawId);
    return this.admins.resetPassword(await this.allow(user, 'update'), id);
  }

  /**
   * 메뉴 권한에 더해 플랫폼 계정 — 플랫폼 BP 소속 PM · PA(isPlatformAdmin) — 이어야 한다. 권한 행이 BP 쪽
   * 권한 그룹에 잘못 붙거나, PM · PA 역할이 고객 BP 계정에 잘못 붙어도 플랫폼 관리자를 다루지 못하게 막는다 —
   * 서비스의 마스터 보호는 PM 이 아니면 PA 로 본다.
   */
  private async allow(user: AuthUser, action: MenuAction) {
    const caller = await this.permissions.assert(user.id, MENU, action);
    if (!(await this.scope.isPlatformAdmin(caller.adminAccountId)))
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return caller;
  }
}

/** 경로의 id 는 문자열이다. 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = /^[0-9]{1,10}$/.test(raw) ? Number(raw) : 0;
  if (id < 1 || id > INT4_MAX)
    throw new NotFoundException('플랫폼 관리자 계정을 찾을 수 없습니다');
  return id;
}
