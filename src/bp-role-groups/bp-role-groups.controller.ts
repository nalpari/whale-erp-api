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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import {
  CreatePlatformRoleGroupResponseDto,
  RoleGroupDeletionCandidatesResponseDto,
  RoleGroupMenuRevocationPreviewResponseDto,
  SaveRoleGroupMenusResponseDto,
} from '../platform-role-groups/dto/platform-role-group.response.dto';
import {
  CreatePlatformRoleGroupDto,
  DeletePlatformRoleGroupDto,
  PreviewRoleGroupMenusDto,
  SaveRoleGroupMenusDto,
  UpdatePlatformRoleGroupDto,
} from '../platform-role-groups/dto/save-platform-role-group.dto';
import { NOT_FOUND } from '../platform-role-groups/platform-role-group-format';
import { BP_ROLE_MENU } from './bp-role-group-access';
import { BpRoleGroupMenusService } from './bp-role-group-menus.service';
import { BpRoleGroupsService } from './bp-role-groups.service';
import {
  BpRoleGroupDetailResponseDto,
  BpRoleGroupListResponseDto,
  BpRoleGroupMenuTreeResponseDto,
} from './dto/bp-role-group.response.dto';
import {
  BpRoleGroupScopeDto,
  ListBpRoleGroupsDto,
} from './dto/list-bp-role-groups.dto';

const NOT_FOUND_DESCRIPTION =
  '없거나 지운 권한 · 호출자 범위 밖 그룹(고정 권한 · 플랫폼 권한 · 다른 가맹 마스터의 FA 포함)';

/**
 * BP 권한 그룹 관리(MN000013, /bp-role-groups). 경로마다 `@MenuPermission` 가드가 메뉴 권한(조회 · 등록 · 수정 ·
 * 삭제)을 보고, 그다음 서비스가 역할 범위를 본다 — BM 은 그 BP 의 BA, FM 은 본인 FA 만 쓰고, 나머지는 조회만 한다. 플랫폼 사용자는 bpCodeId 가
 * 필수다. 버튼 노출은 화면이 메뉴 권한(usePagePermission)과 응답의 역할 플래그를 합쳐 정한다.
 *
 * 가드가 파이프보다 먼저 돌므로 권한이 없으면 id · 본문 검사(404 · 400)보다 403 이 먼저 나온다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '메뉴 권한 없음 · 다른 BP · 역할로 쓸 수 없음 · 연결 가맹 마스터 없는 가맹 관리자(공용 문구) · 본인이 연결된 권한',
})
@ApiBadRequestResponse({
  description: '플랫폼 사용자의 bpCodeId 누락 · 없는 BP',
})
@UserTypes('admin')
@Controller('bp-role-groups')
export class BpRoleGroupsController {
  constructor(
    private readonly groups: BpRoleGroupsService,
    private readonly menuService: BpRoleGroupMenusService,
  ) {}

  /** 목록 — 권한 코드 순(BA 다음 FA), 쪽 나눔. creatableRoleTypeCode 는 역할로 정한 등록 유형이다. */
  @Get()
  @MenuPermission(BP_ROLE_MENU, 'read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListBpRoleGroupsDto,
  ): Promise<BpRoleGroupListResponseDto> {
    const scope = await this.groups.scopeOf(user.id, query.bpCodeId);
    return this.groups.list(scope, {
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /** 등록 — BM 은 BA, FM 은 FA(관리계정 = 본인). 유형은 받지 않는다. */
  @Post()
  @MenuPermission(BP_ROLE_MENU, 'create')
  @ApiConflictResponse({
    description: '같은 이름의 권한(같은 BP · 같은 관리계정) · 권한 코드 소진',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Query() query: BpRoleGroupScopeDto,
    @Body() body: CreatePlatformRoleGroupDto,
  ): Promise<CreatePlatformRoleGroupResponseDto> {
    return this.groups.create(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      body,
    );
  }

  /** 가맹마스터 보기 — FM000001 메뉴 트리, 모든 칸 읽기 전용. 가맹 관리자는 403. `:id` 보다 먼저 둔다. */
  @Get('franchise-master/menus')
  @MenuPermission(BP_ROLE_MENU, 'read')
  async franchiseMasterMenus(
    @CurrentUser() user: AuthUser,
    @Query() query: BpRoleGroupScopeDto,
  ): Promise<BpRoleGroupMenuTreeResponseDto> {
    return this.menuService.franchiseMasterTree(
      await this.groups.scopeOf(user.id, query.bpCodeId),
    );
  }

  /** 상세 — 역할로 고칠 수 있는지 · 지울 수 있는지와 막힌 이유. */
  @Get(':id')
  @MenuPermission(BP_ROLE_MENU, 'read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
  ): Promise<BpRoleGroupDetailResponseDto> {
    const id = idOf(rawId);
    return this.groups.detail(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
    );
  }

  /** 권한명 · 설명 수정. 상세의 updatedAt 을 함께 보낸다 — 그 사이 고쳐졌으면 409. */
  @Put(':id')
  @MenuPermission(BP_ROLE_MENU, 'update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '같은 이름의 권한 · 동시 수정' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
    @Body() body: UpdatePlatformRoleGroupDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.groups.update(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
      body,
    );
  }

  /** 메뉴 등록 팝업의 트리 — WHALE_ERP 메뉴, 칸마다 현재 값 · 바꿀 수 있는지 · 막힌 이유. */
  @Get(':id/menus')
  @MenuPermission(BP_ROLE_MENU, 'read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async menus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
  ): Promise<BpRoleGroupMenuTreeResponseDto> {
    const id = idOf(rawId);
    return this.menuService.tree(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
    );
  }

  /** 메뉴 권한 저장 — 메뉴별 네 칸 + updatedAt. 응답의 updatedAt 으로 다음 저장을 한다. */
  @Put(':id/menus')
  @MenuPermission(BP_ROLE_MENU, 'update')
  @ApiBadRequestResponse({
    description:
      '숨긴 · 없는 메뉴, 같은 메뉴 두 번, 조회 없는 등록 · 수정 · 삭제, 상한(기준 고정 권한 ∩ 본인 권한) 밖 칸',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '동시 수정' })
  async saveMenus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
    @Body() body: SaveRoleGroupMenusDto,
  ): Promise<SaveRoleGroupMenusResponseDto> {
    const id = idOf(rawId);
    return this.menuService.save(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
      body,
    );
  }

  /** 회수 미리보기 — 꺼지는 칸과 이 그룹의 관리자 수. 하위 그룹이 없어 affectedRoleGroupCount 는 0. 쓰지 않는다. */
  @Post(':id/menus/preview')
  @MenuPermission(BP_ROLE_MENU, 'read')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({ description: '저장과 같은 검사' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async previewMenus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
    @Body() body: PreviewRoleGroupMenusDto,
  ): Promise<RoleGroupMenuRevocationPreviewResponseDto> {
    const id = idOf(rawId);
    return this.menuService.preview(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
      body,
    );
  }

  /** 삭제 대화상자 — 옮길 연결 사용자와 대체 후보(같은 BP · 유형 · 관리계정). */
  @Get(':id/deletion-candidates')
  @MenuPermission(BP_ROLE_MENU, 'read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async deletionCandidates(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
  ): Promise<RoleGroupDeletionCandidatesResponseDto> {
    const id = idOf(rawId);
    return this.groups.deletionCandidates(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
    );
  }

  /** 삭제(논리 삭제). 연결 사용자가 있으면 대체 그룹으로 옮긴 뒤 지운다. 지운 권한 코드는 다시 쓰지 않는다. */
  @Delete(':id')
  @MenuPermission(BP_ROLE_MENU, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description: '연결 사용자가 있는데 대체 권한 없음 · 후보가 아닌 대체 권한',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '동시 수정' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: BpRoleGroupScopeDto,
    @Body() body: DeletePlatformRoleGroupDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.groups.remove(
      await this.groups.scopeOf(user.id, query.bpCodeId),
      id,
      body,
    );
  }
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(NOT_FOUND);
  return id;
}
