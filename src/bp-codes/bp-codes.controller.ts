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
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { CodesService } from '../codes/codes.service';
import { CodeItemsQueryDto } from '../codes/dto/code-items.query.dto';
import { CodeItemsResponseDto } from '../codes/dto/code-items.response.dto';
import { BpStoreListResponseDto } from './dto/bp-store-list.response.dto';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';

const NOT_FOUND_MESSAGE = 'BP 를 찾을 수 없습니다';
const MAX_ID = 2_147_483_647;

/**
 * BP 를 id 로 가리키는 조회. 로그인한 누구나(관리자 · 직원 앱) 부른다. 점포 목록은 플랫폼 관리자(PM · PA)면 어느
 * 고객 BP 든, 그 밖에는 자기 BP 만이고(2026-10-14 재영), 공통코드는 어느 BP 든이다.
 */
@ApiBearerAuth()
@ApiNotFoundResponse({ description: '없거나 삭제된 BP' })
@Controller('bp-codes')
export class BpCodesController {
  constructor(
    private readonly scope: AdminScopeService,
    private readonly codes: CodesService,
  ) {}

  /**
   * 그 BP 의 점포 전체 — 점포 선택 목록. 선택 목록이라 나눠 주지 않는다. 플랫폼 관리자(PM · PA)는 어느 고객 BP 든,
   * BP · 가맹 관리자는 자기 BP 만, 직원 앱은 가입 · 재직 중인 점포가 있는 BP 만이다. 볼 수 없는 BP 는 없는 BP 와
   * 같이 404 — 다른 BP 가 있는지 드러내지 않는다. 플랫폼 BP 도 404. 사용 중인 관리자 계정이 아니면 403.
   * shortcut: 페이지 없이 전부 준다, 한 BP 의 점포가 수백을 넘으면 page · pageSize 를 붙인다.
   */
  @ApiForbiddenResponse({ description: '사용할 수 없는 관리자 계정' })
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
   * 그 BP 가 보는 공통코드 — 공개 `GET /public-code-items` 와 같은 `groups` · 응답 모양.
   * 로그인한 누구나(관리자는 권한 유형과 상관없이, 직원 앱도) 부른다. 부를 때의 현재 값이다.
   */
  @Get(':bpCodeId/code-items')
  async findCodeItems(
    @Param('bpCodeId') rawId: string,
    @Query() { groups }: CodeItemsQueryDto,
  ): Promise<CodeItemsResponseDto> {
    const codes = await this.codes.forBpId(bpIdOf(rawId), groups);
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
