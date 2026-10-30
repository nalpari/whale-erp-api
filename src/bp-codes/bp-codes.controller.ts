import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { CodesService } from '../codes/codes.service';
import { CodeItemsQueryDto } from '../codes/dto/code-items.query.dto';
import { CodeItemsResponseDto } from '../codes/dto/code-items.response.dto';
import { BpListResponseDto } from './dto/bp-list.response.dto';
import { BpStoreListResponseDto } from './dto/bp-store-list.response.dto';
import { BpStoresVersionResponseDto } from './dto/bp-stores-version.response.dto';
import { ListBpCodesDto } from './dto/list-bp-codes.dto';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';

const NOT_FOUND_MESSAGE = 'BP 를 찾을 수 없습니다.';
const MAX_ID = 2_147_483_647;
const NOT_FOUND_DESCRIPTION = '없거나 삭제된 BP';

/**
 * BP 선택 목록(플랫폼 관리자 전용)과 BP 를 id 로 가리키는 조회. id 로 가리키는 조회는 로그인한 누구나(관리자 ·
 * 직원 앱) 부른다. 플랫폼 관리자(PM · PA)는 점포 목록이면 어느 고객 BP 든, 공통코드면 플랫폼 BP 까지 어느 BP 든
 * 본다. BP · 가맹 관리자는 자기 BP, 직원 앱은 가입 · 재직 중인 점포가 있는 BP 만이다(2026-10-14 재영, 공통코드는
 * 2026-10-21 탭 BP 계획 — 남의 BP 공통코드가 나오던 것을 막았다).
 */
@ApiBearerAuth()
@Controller('bp-codes')
export class BpCodesController {
  constructor(
    private readonly scope: AdminScopeService,
    private readonly codes: CodesService,
  ) {}

  /**
   * 플랫폼 계정이 고를 고객 BP — 서비스 바로가기 「웨일ERP」의 BP 선택. 미삭제 고객 BP 를 사용 · 미사용 · 탈퇴 모두
   * 최신 등록순으로 나눠 준다. withMaster 면 BP 마스터 계정이 있는 BP 만(BP 마스터 계정 목록과 같은 범위 · 순서). 사용 중인 플랫폼 관리자(PM · PA)만 부르고, 그 밖의 관리자 · 직원 앱은 403.
   */
  @ApiForbiddenResponse({
    description:
      '플랫폼 관리자가 아님 · 사용할 수 없는 관리자 계정 · 직원 앱 토큰',
  })
  @UserTypes('admin')
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListBpCodesDto,
  ): Promise<BpListResponseDto> {
    const access = await this.scope.platformAdminAccess(user.id);
    if (access === 'unavailable')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    // 허용만 통과시킨다 — 판정 값이 늘어도 열리지 않게.
    if (access !== 'allowed')
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return this.scope.listBps(query);
  }

  /**
   * 그 BP 의 점포 전체 — 점포 선택 목록. 선택 목록이라 나눠 주지 않는다. 플랫폼 관리자(PM · PA)는 어느 고객 BP 든,
   * BP · 가맹 관리자는 자기 BP 만, 직원 앱은 가입 · 재직 중인 점포가 있는 BP 만이다. 볼 수 없는 BP 는 없는 BP 와
   * 같이 404 — 다른 BP 가 있는지 드러내지 않는다. 플랫폼 BP 도 404. 사용 중인 관리자 계정이 아니면 403.
   * shortcut: 페이지 없이 전부 준다, 한 BP 의 점포가 수백을 넘으면 page · pageSize 를 붙인다.
   */
  @ApiForbiddenResponse({ description: '사용할 수 없는 관리자 계정' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @Get(':bpCodeId/stores')
  async findStores(
    @CurrentUser() user: AuthUser,
    @Param('bpCodeId') rawId: string,
  ): Promise<BpStoreListResponseDto> {
    const bpCodeId = bpIdOf(rawId);
    const access = await this.scope.bpStoresAccess(user, bpCodeId);
    if (access === 'unavailable')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    if (access === 'denied') throw new NotFoundException(NOT_FOUND_MESSAGE);
    const items = await this.scope.listBpStores(bpCodeId);
    if (!items) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { items, total: items.length };
  }

  /**
   * 그 BP 점포 목록의 버전 — 관리자 웹이 새로고침 · 메뉴 이동 · 창 포커스 때 버전만 묻고, 바뀌었을 때만 점포 목록
   * (자기 BP 는 로그인 정보의 stores, 연 BP 는 위 점포 목록)을 다시 받는다. 여러 PC 에서 같은 계정으로 쓸 때 다른 PC 의
   * 점포 등록 · 수정 · 폐점 · 삭제와 담당 점포 매핑 · 관리 범위 변경을 잡는다(BP · 가맹 관리자만 매핑 · 범위까지).
   * 볼 수 있는 BP 와 오류는 점포 목록과 같다(bpStoresAccess) — 볼 수 없는 BP · 플랫폼 BP 는 404, 사용 중인 관리자
   * 계정이 아니면 403.
   */
  @ApiForbiddenResponse({ description: '사용할 수 없는 관리자 계정' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @Get(':bpCodeId/stores-version')
  async findStoresVersion(
    @CurrentUser() user: AuthUser,
    @Param('bpCodeId') rawId: string,
  ): Promise<BpStoresVersionResponseDto> {
    const bpCodeId = bpIdOf(rawId);
    const access = await this.scope.bpStoresAccess(user, bpCodeId);
    if (access === 'unavailable')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    if (access === 'denied') throw new NotFoundException(NOT_FOUND_MESSAGE);
    const version = await this.scope.bpStoresVersion(user, bpCodeId);
    if (version === null) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { version };
  }

  /**
   * 그 BP 가 보는 공통코드 — 공개 `GET /public-code-items` 와 같은 `groups` · 응답 모양. 부를 때의 현재 값이다.
   * 볼 수 있는 BP 는 점포 목록과 같다(bpStoresAccess) — 플랫폼 관리자는 어느 BP 든, BP · 가맹 관리자는 자기 BP 만,
   * 직원 앱은 가입 · 재직 중인 점포가 있는 BP 만. 볼 수 없는 BP 는 없는 BP 와 같이 404, 사용 중인 관리자 계정이
   * 아니면 403.
   */
  @ApiForbiddenResponse({ description: '사용할 수 없는 관리자 계정' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @Get(':bpCodeId/code-items')
  async findCodeItems(
    @CurrentUser() user: AuthUser,
    @Param('bpCodeId') rawId: string,
    @Query() { groups }: CodeItemsQueryDto,
  ): Promise<CodeItemsResponseDto> {
    const bpCodeId = bpIdOf(rawId);
    const access = await this.scope.bpStoresAccess(user, bpCodeId);
    if (access === 'unavailable')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    if (access === 'denied') throw new NotFoundException(NOT_FOUND_MESSAGE);
    const codes = await this.codes.forBpId(bpCodeId, groups);
    if (!codes) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { codes };
  }
}

/** 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 500 이 된다. */
function bpIdOf(rawId: string): number {
  const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
  if (id < 1 || id > MAX_ID) throw new NotFoundException(NOT_FOUND_MESSAGE);
  return id;
}
