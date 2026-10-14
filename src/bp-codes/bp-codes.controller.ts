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
import { BpStoreListResponseDto } from './dto/bp-store-list.response.dto';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';

const NOT_FOUND_MESSAGE = 'BP 를 찾을 수 없습니다';
const MAX_ID = 2_147_483_647;

/** 플랫폼 사용자(PM · PA)가 고객 BP 를 골라 새 탭으로 들어갈 때 쓴다. */
@ApiBearerAuth()
@UserTypes('admin')
@ApiForbiddenResponse({ description: '플랫폼 마스터 · 플랫폼 관리자가 아님' })
@ApiNotFoundResponse({ description: '없거나 삭제된 BP · 플랫폼 BP' })
@Controller('bp-codes')
export class BpCodesController {
  constructor(
    private readonly scope: AdminScopeService,
    private readonly codes: CodesService,
  ) {}

  /** 플랫폼 사용자가 아니면 403, 정수 범위 밖이면 404. 거른 id 를 돌려준다. */
  private async platformBpId(user: AuthUser, rawId: string) {
    if (!(await this.scope.isPlatformAdmin(user.id)))
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    // DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 500 이 된다.
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return id;
  }

  /**
   * 그 BP 의 점포 전체 — 점포 선택 목록. 선택 목록이라 나눠 주지 않는다.
   * shortcut: 페이지 없이 전부 준다, 한 BP 의 점포가 수백을 넘으면 page · pageSize 를 붙인다.
   */
  @Get(':bpCodeId/stores')
  async findStores(
    @CurrentUser() user: AuthUser,
    @Param('bpCodeId') rawId: string,
  ): Promise<BpStoreListResponseDto> {
    const items = await this.scope.listBpStores(
      await this.platformBpId(user, rawId),
    );
    if (!items) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { items, total: items.length };
  }

  /**
   * 그 BP 가 보는 공통코드 — 공개 `GET /public-bp-codes/{bpCode}/code-items` 와 같은 `groups` · 응답 모양.
   * 부를 때의 현재 값이다.
   */
  @Get(':bpCodeId/code-items')
  async findCodeItems(
    @CurrentUser() user: AuthUser,
    @Param('bpCodeId') rawId: string,
    @Query() { groups }: CodeItemsQueryDto,
  ): Promise<CodeItemsResponseDto> {
    const codes = await this.codes.forCustomerBpId(
      await this.platformBpId(user, rawId),
      groups,
    );
    if (!codes) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { codes };
  }
}
