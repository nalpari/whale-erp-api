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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import {
  CreatePlatformMenuResponseDto,
  PlatformMenuDetailResponseDto,
  PlatformMenuServiceListResponseDto,
  PlatformMenuTreeResponseDto,
} from './dto/platform-menu.response.dto';
import {
  CreatePlatformMenuDto,
  MovePlatformMenuDto,
  PlatformMenuTreeQueryDto,
  UpdatePlatformMenuDto,
} from './dto/save-platform-menu.dto';
import { NOT_FOUND, PLATFORM_MENU_MENU } from './platform-menu-format';
import { PlatformMenusService } from './platform-menus.service';

const WRITE_BUSY = '쓰기가 몰려 트랜잭션 시간을 넘김 — 잠시 뒤 다시 시도';

/**
 * 플랫폼 메뉴 관리(MN000215, /platform-menus). 경로마다 @MenuPermission 으로 메뉴 권한을 동작별로 판정하고(옮기기는 수정),
 * platformOnly 로 호출자가 플랫폼 BP 의 사용 중 PM · PA 인지도 본다 — 권한 행이 BP 쪽 그룹에 잘못 붙어도 막는다.
 * 메뉴 삭제는 없다 — 안 쓰는 메뉴는 사용중지로 돌린다(F-CWWQUR).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '메뉴 권한 없음 · 플랫폼 계정이 아님(공용 문구)',
})
@UserTypes('admin')
@Controller('platform-menus')
export class PlatformMenusController {
  constructor(private readonly menus: PlatformMenusService) {}

  /** 서비스 탭 — 공통코드 SERVICE 전부(사용중지 포함)와 서비스별 메뉴 수(사용 · 미사용). */
  @Get('services')
  @MenuPermission(PLATFORM_MENU_MENU, 'read', { platformOnly: true })
  async services(): Promise<PlatformMenuServiceListResponseDto> {
    return this.menus.services();
  }

  /** 서비스 하나의 메뉴 트리 — 페이지 · 검색 없이 전부, 형제 순서대로 중첩. */
  @Get()
  @MenuPermission(PLATFORM_MENU_MENU, 'read', { platformOnly: true })
  @ApiBadRequestResponse({ description: '서비스 코드 형식' })
  @ApiNotFoundResponse({ description: '없는 서비스' })
  async tree(
    @Query() query: PlatformMenuTreeQueryDto,
  ): Promise<PlatformMenuTreeResponseDto> {
    return this.menus.tree(query.serviceCode);
  }

  /** 메뉴 상세. */
  @Get(':id')
  @MenuPermission(PLATFORM_MENU_MENU, 'read', { platformOnly: true })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async detail(
    @Param('id') rawId: string,
  ): Promise<PlatformMenuDetailResponseDto> {
    return this.menus.detail(idOf(rawId));
  }

  /** 메뉴 등록 — 고른 상위(없으면 최상위)의 맨 끝에. 코드는 저장할 때 채번하고, 플랫폼 마스터 권한 행을 함께 넣는다. */
  @Post()
  @MenuPermission(PLATFORM_MENU_MENU, 'create', { platformOnly: true })
  @ApiBadRequestResponse({
    description:
      '형식(메뉴명 · URL · 서비스 코드) · 없는 서비스 · 고를 수 없는 상위(없음 · 다른 서비스) · 3단계 메뉴 아래',
  })
  @ApiConflictResponse({
    description:
      '같거나 겹치는 URL 을 쓰는 사용 중 메뉴 · 메뉴 코드를 더 만들 수 없음',
  })
  @ApiServiceUnavailableResponse({ description: WRITE_BUSY })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePlatformMenuDto,
  ): Promise<CreatePlatformMenuResponseDto> {
    return this.menus.create(user.id, body);
  }

  /** 노출 메뉴명 · URL · 사용 상태 저장 — 통째로 바꾼다(URL 을 빼면 비운다). */
  @Put(':id')
  @MenuPermission(PLATFORM_MENU_MENU, 'update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description: '형식(메뉴명 · URL · 상태 · updatedAt)',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: '같거나 겹치는 URL 을 쓰는 사용 중 메뉴 · 동시 수정',
  })
  @ApiServiceUnavailableResponse({ description: WRITE_BUSY })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdatePlatformMenuDto,
  ): Promise<void> {
    await this.menus.update(user.id, idOf(rawId), body);
  }

  /**
   * 위치 옮기기 — 같은 서비스 안에서, 하위가 함께 간다. 옮길 때마다 바로 저장된다. 어느 메뉴의 updatedAt · 수정자도
   * 바꾸지 않아, 열어 둔 상세는 다시 불러오지 않고 저장해도 된다.
   */
  @Post(':id/move')
  @MenuPermission(PLATFORM_MENU_MENU, 'update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      '자기 자신이나 하위 아래 · 3단계 초과(하위 높이 포함) · 다른 서비스나 없는 상위',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ description: WRITE_BUSY })
  async move(
    @Param('id') rawId: string,
    @Body() body: MovePlatformMenuDto,
  ): Promise<void> {
    await this.menus.move(idOf(rawId), body);
  }
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(NOT_FOUND);
  return id;
}
