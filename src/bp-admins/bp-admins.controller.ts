import {
  Body,
  Controller,
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
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { AdminProfileEmailAvailabilityQueryDto } from '../auth/dto/admin-profile-email-availability-query.dto';
import { AdminProfileEmailAvailabilityResponseDto } from '../auth/dto/admin-profile-email-availability.response.dto';
import { parseRouteId } from '../common/route-id';
import { PageDto } from '../platform-admins/dto/list-platform-admins.dto';
import {
  LoginIdAvailabilityQueryDto,
  LoginIdAvailabilityResponseDto,
} from '../platform-admins/dto/login-id-availability.dto';
import { BpAdminsService } from './bp-admins.service';
import {
  BpAdminDetailResponseDto,
  BpAdminHistoryListResponseDto,
  BpAdminListResponseDto,
  BpAdminRoleGroupListResponseDto,
  BpAdminStoreOptionListResponseDto,
  BpAdminUpdateImpactResponseDto,
  CreateBpAdminResponseDto,
  ResetBpAdminPasswordResponseDto,
} from './dto/bp-admin.response.dto';
import {
  BpAdminRoleQueryDto,
  BpAdminStoreOptionsQueryDto,
  BpAdminUpdateImpactQueryDto,
  ListBpAdminsDto,
} from './dto/list-bp-admins.dto';
import { CreateBpAdminDto, UpdateBpAdminDto } from './dto/save-bp-admin.dto';

const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';

/**
 * BP 관리자 관리. 관리자 웹 메뉴(`/bp-admins`, MN000012)의 권한으로 경로마다 @MenuPermission 이 판정하고, 대상 BP 는
 * X-Bp-Code-Id → `@TargetBp()` 로 받는다. 플랫폼 사용자는 고른 BP 의 계정을 등록 · 수정 · 초기화까지 한다.
 * 역할 규칙(누가 누구를 보고 고치는가)은 서비스가 호출자를 읽어 판정한다. 삭제 경로는 없다(계정 회수 기능 없음).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '쓸 수 없는 계정 · 메뉴 권한 없음 · 다른 BP · 역할 규칙(등록할 수 없는 역할, 연결 가맹 마스터가 아님, 본인 계정의 권한 · 상태 · 점포)',
})
@ApiBadRequestResponse({
  description:
    '입력 형식 · 플랫폼 사용자의 BP 미선택 · 선택할 수 없는 권한 · 점포 범위 밖 · 폐점 점포 · 점포 없음',
})
@UserTypes('admin')
@Controller('bp-admins')
export class BpAdminsController {
  constructor(private readonly admins: BpAdminsService) {}

  /** 목록. 대상 BP 의 BP 관리자 · 가맹 마스터 · 가맹 관리자, 등록일시 최신순. 가맹 쪽은 본인과 점포가 겹치는 가맹 관리자만. */
  @Get()
  @MenuPermission('read')
  list(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListBpAdminsDto,
  ): Promise<BpAdminListResponseDto> {
    return this.admins.list(user.id, bp, query);
  }

  /** 권한 그룹 선택지(목록 필터 · 등록 · 수정). `:id` 보다 먼저 둔다. */
  @Get('role-groups')
  @MenuPermission('read')
  roleGroups(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: BpAdminRoleQueryDto,
  ): Promise<BpAdminRoleGroupListResponseDto> {
    return this.admins.roleGroups(user.id, bp, query.roleTypeCode);
  }

  /** 점포 선택지. 고를 수 있는 점포만 준다 — 폐점과, 가맹 마스터라면 다른 가맹 마스터 담당 점포는 빠진다. */
  @Get('store-options')
  @MenuPermission('read')
  storeOptions(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: BpAdminStoreOptionsQueryDto,
  ): Promise<BpAdminStoreOptionListResponseDto> {
    return this.admins.storeOptions(user.id, bp, query);
  }

  /** 아이디 중복 확인. 등록 화면이 칸을 벗어나거나 Enter 를 칠 때 묻는다. 등록 권한이 필요하다. */
  @Get('login-id-availability')
  @MenuPermission('create')
  @ApiBadRequestResponse({ description: '아이디 형식' })
  async loginIdAvailability(
    @Query() query: LoginIdAvailabilityQueryDto,
  ): Promise<LoginIdAvailabilityResponseDto> {
    return {
      available: await this.admins.isLoginIdAvailable(query.loginId),
    };
  }

  /** 이메일 중복 확인. 아이디와 같은 때(칸을 벗어나거나 Enter) 묻는다. 등록 권한이 필요하다. 소문자로 맞춰 본다. */
  @Get('email-availability')
  @MenuPermission('create')
  @ApiBadRequestResponse({ description: '이메일 형식' })
  async emailAvailability(
    @Query() query: AdminProfileEmailAvailabilityQueryDto,
  ): Promise<AdminProfileEmailAvailabilityResponseDto> {
    return { available: await this.admins.isEmailAvailable(query.email) };
  }

  /** 상세. 버튼 판정(actions)을 함께 준다. 볼 수 없는 계정 · BP 마스터 · 다른 BP 계정은 404. */
  @Get(':id')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: '없거나 볼 수 없는 계정' })
  detail(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<BpAdminDetailResponseDto> {
    return this.admins.detail(user.id, bp, idOf(rawId));
  }

  /** 변경 이력. 최신순. */
  @Get(':id/histories')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: '없거나 볼 수 없는 계정' })
  histories(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Query() query: PageDto,
  ): Promise<BpAdminHistoryListResponseDto> {
    return this.admins.histories(user.id, bp, idOf(rawId), query);
  }

  /** 가맹 마스터 저장 전 확인창의 수 — 함께 미사용이 되는 · 점포 매핑이 빠지는 가맹 관리자. */
  @Get(':id/update-impact')
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: '없거나 볼 수 없는 계정' })
  updateImpact(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Query() query: BpAdminUpdateImpactQueryDto,
  ): Promise<BpAdminUpdateImpactResponseDto> {
    return this.admins.updateImpact(user.id, bp, idOf(rawId), query);
  }

  /** 등록. 늘 사용으로 만들고 1시간짜리 초기 비밀번호를 메일로만 보낸다. 메일이 실패해도 계정은 남는다. */
  @Post()
  @MenuPermission('create')
  @ApiNotFoundResponse({ description: '그사이 지워진 BP' })
  @ApiConflictResponse({
    description:
      '아이디 · 이메일 중복 · 다른 가맹 마스터가 맡은 점포 · 미사용 BP',
  })
  create(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: CreateBpAdminDto,
  ): Promise<CreateBpAdminResponseDto> {
    return this.admins.create(user.id, bp, body);
  }

  /** 수정. 상세에서 받은 updatedAt 을 함께 보낸다 — 그 사이 다른 사람이 고쳤으면 409. */
  @Put(':id')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({
    description: '없거나 볼 수 없는 계정 · 그사이 지워진 BP',
  })
  @ApiConflictResponse({
    description:
      '이메일 중복 · 동시 수정 · 다른 가맹 마스터가 맡은 점포 · 미사용 BP 에 사용으로 저장',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Body() body: UpdateBpAdminDto,
  ): Promise<void> {
    await this.admins.update(user.id, bp, idOf(rawId), body);
  }

  /**
   * 비밀번호 초기화. 새 1시간짜리 임시 비밀번호를 그 계정 이메일로만 보내고 잠금을 푼다. 미사용 계정도 된다.
   * 응답의 updatedAt 으로 다음 수정을 저장한다 — 초기화가 그 값을 올린다.
   */
  @Post(':id/password-reset')
  @MenuPermission('update')
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({ description: '없거나 볼 수 없는 계정' })
  @ApiConflictResponse({
    description: '이메일이 없는 계정 · 그 사이 이메일 · 역할이 바뀜',
  })
  @ApiServiceUnavailableResponse({
    description:
      '메일 설정(MAIL_* · ADMIN_WEB_URL)이 없는 환경 — 아무것도 바꾸지 않는다',
  })
  resetPassword(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<ResetBpAdminPasswordResponseDto> {
    return this.admins.resetPassword(user.id, bp, idOf(rawId));
  }
}

/** 경로의 id 는 문자열이다. 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(NOT_FOUND);
  return id;
}
