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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import {
  type MenuAction,
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import {
  CreatePlatformRoleGroupResponseDto,
  PlatformRoleGroupDetailResponseDto,
  PlatformRoleGroupSummaryListResponseDto,
  RoleGroupDeletionCandidatesResponseDto,
  RoleGroupMenuRevocationPreviewResponseDto,
  RoleGroupMenuTreeResponseDto,
  SaveRoleGroupMenusResponseDto,
} from './dto/platform-role-group.response.dto';
import {
  CreatePlatformRoleGroupDto,
  DeletePlatformRoleGroupDto,
  PreviewRoleGroupMenusDto,
  SaveRoleGroupMenusDto,
  UpdatePlatformRoleGroupDto,
} from './dto/save-platform-role-group.dto';
import { NOT_FOUND, PLATFORM_ROLE_MENU } from './platform-role-group-format';
import { PlatformRoleGroupMenusService } from './platform-role-group-menus.service';
import { PlatformRoleGroupsService } from './platform-role-groups.service';

const NOT_FOUND_DESCRIPTION =
  '없거나 지운 권한 · 플랫폼 권한(PM · PA · BM · FM)이 아닌 그룹';

/**
 * 플랫폼 권한 관리(MN000214, /platform-role-groups). 관리자 웹의 메뉴 권한(조회 · 등록 · 수정 · 삭제)으로
 * 동작마다 판정하고, 호출자가 플랫폼 BP 의 사용 중 PM · PA 여야 한다. 본인 연결 · 고정 권한 · 본인 범위 상한은
 * 서비스가 본다. 권한을 바꾸면 그 그룹의 관리자는 다시 로그인하지 않아도 다음 요청부터 새 권한으로 판정된다
 * (가드 · MenuPermissionsService 가 요청마다 DB 를 읽는다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '메뉴 권한 없음 · 플랫폼 계정이 아님(공용 문구) · 본인이 연결된 권한',
})
@UserTypes('admin')
@Controller('platform-role-groups')
export class PlatformRoleGroupsController {
  constructor(
    private readonly groups: PlatformRoleGroupsService,
    private readonly menuService: PlatformRoleGroupMenusService,
    private readonly permissions: MenuPermissionsService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 목록. 고정 권한(PM · PA · BM · FM 순, 시드는 PA 없이 셋) 다음 플랫폼 관리자 추가 권한을 코드 순으로, 페이지 없이. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<PlatformRoleGroupSummaryListResponseDto> {
    await this.allow(user, 'read');
    return this.groups.list();
  }

  /** 등록 — 플랫폼 관리자(PA) 추가 권한. 권한 코드는 PA + 6자리로 채번한다. */
  @Post()
  @ApiBadRequestResponse({ description: '권한명 · 설명 형식' })
  @ApiConflictResponse({
    description: '같은 이름의 권한 · 권한 코드를 더 만들 수 없음',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePlatformRoleGroupDto,
  ): Promise<CreatePlatformRoleGroupResponseDto> {
    return this.groups.create(await this.allow(user, 'create'), body);
  }

  /** 상세. 권한명 · 설명을 고칠 수 있는지 · 지울 수 있는지와 막힌 이유를 함께 준다. */
  @Get(':id')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PlatformRoleGroupDetailResponseDto> {
    const id = idOf(rawId);
    return this.groups.detail(await this.allow(user, 'read'), id);
  }

  /** 권한명 · 설명 수정. 상세에서 받은 updatedAt 을 함께 보낸다 — 그 사이 다른 사람이 고쳤으면 409. */
  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: '권한명 · 설명 형식' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '같은 이름의 권한 · 동시 수정' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdatePlatformRoleGroupDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.groups.update(await this.allow(user, 'update'), id, body);
  }

  /** 메뉴 등록 팝업의 트리 — 사용 중 서비스별, 칸마다 현재 값 · 바꿀 수 있는지 · 막힌 이유. */
  @Get(':id/menus')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async menus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<RoleGroupMenuTreeResponseDto> {
    const id = idOf(rawId);
    return this.menuService.tree(await this.allow(user, 'read'), id);
  }

  /**
   * 메뉴 권한 저장. 메뉴별 네 칸 목록 + updatedAt. BP · 가맹 마스터에서 끈 칸은 모든 BP 의 BA · FA 그룹에서도
   * 함께 꺼진다. 응답의 updatedAt 으로 다음 저장을 한다.
   */
  @Put(':id/menus')
  @ApiBadRequestResponse({
    description:
      '숨긴 · 없는 메뉴, 같은 메뉴 두 번, 조회 없는 등록 · 수정 · 삭제, BP · 가맹 마스터의 플랫폼 메뉴 켜기(끄기는 받는다), 본인 권한 범위 밖 칸(조회를 끄면 함께 꺼지는 칸 포함)',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: '플랫폼 마스터 권한(전체 허용 고정) · 동시 수정',
  })
  async saveMenus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: SaveRoleGroupMenusDto,
  ): Promise<SaveRoleGroupMenusResponseDto> {
    const id = idOf(rawId);
    return this.menuService.save(await this.allow(user, 'update'), id, body);
  }

  /** 회수 미리보기 — 저장할 목록으로 꺼지는 칸 · 함께 빠지는 하위 권한 그룹 · 연결 사용자를 센다. 쓰지 않는다. */
  @Post(':id/menus/preview')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({
    description:
      '숨긴 · 없는 메뉴, 같은 메뉴 두 번, 조회 없는 등록 · 수정 · 삭제, BP · 가맹 마스터의 플랫폼 메뉴 켜기, 본인 권한 범위 밖 칸 — 저장과 같은 검사',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: '플랫폼 마스터 권한(전체 허용 고정) — 저장과 같다',
  })
  async previewMenus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: PreviewRoleGroupMenusDto,
  ): Promise<RoleGroupMenuRevocationPreviewResponseDto> {
    const id = idOf(rawId);
    return this.menuService.preview(await this.allow(user, 'read'), id, body);
  }

  /** 삭제 대화상자 — 옮길 연결 사용자와 대체 권한 후보. */
  @Get(':id/deletion-candidates')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '지울 수 없는 권한 — 고정 권한 · 플랫폼 관리자 추가 권한이 아님',
  })
  async deletionCandidates(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<RoleGroupDeletionCandidatesResponseDto> {
    const id = idOf(rawId);
    await this.allow(user, 'read');
    return this.groups.deletionCandidates(id);
  }

  /**
   * 삭제 — 플랫폼 관리자 추가 권한만(논리 삭제). 연결 사용자가 있으면 대체 권한으로 한꺼번에 옮긴 뒤 지운다.
   * 지운 권한 코드는 다시 쓰지 않는다.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      '연결 사용자가 있는데 대체 권한 없음 · 고를 수 없는 대체 권한(없거나 지운 권한 · 플랫폼 BP 가 아닌 권한 · 고정 권한 · 다른 유형 · 자기 자신). 연결 사용자가 없어도 보낸 대체 권한은 검사한다',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: '고정 권한 · 플랫폼 관리자 추가 권한이 아님 · 동시 수정',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: DeletePlatformRoleGroupDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.groups.remove(await this.allow(user, 'delete'), id, body);
  }

  /**
   * 메뉴 권한에 더해 플랫폼 BP 의 사용 중 PM · PA 여야 한다. 권한 행이 BP 쪽 그룹에 잘못 붙어도 BP 계정이
   * 플랫폼 권한(그리고 그 아래 BA · FA 상한)을 다루지 못하게 막는다.
   */
  private async allow(user: AuthUser, action: MenuAction): Promise<MenuCaller> {
    const caller = await this.permissions.assert(
      user.id,
      PLATFORM_ROLE_MENU,
      action,
    );
    if (!(await this.scope.isPlatformAdmin(caller.adminAccountId)))
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return caller;
  }
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(NOT_FOUND);
  return id;
}
