import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
  StaffMemberListItemDto,
  StaffMemberListResponseDto,
} from './dto/staff-member-list.response.dto';
import { StaffMemberListService } from './staff-member-list.service';
import { STAFF_MENU, STAFF_NOT_FOUND_MESSAGE } from './staff-menu';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';

/**
 * 직원 정보 관리 목록 (WHALEERP-329) · 상세 (WHALEERP-599). 관리자 웹만 쓰고, 직원 정보 관리 조회 권한이 있어야
 * 한다 — 직원 앱 토큰 · 권한 없는 관리자는 403. 관리 범위 밖 점포는 storeIds 로 골라도 조용히 빠진다(오류를 주면
 * 다른 BP 에 그 점포가 있다는 것이 드러난다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 정보 관리 조회 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@MenuPermission(STAFF_MENU, 'read')
@Controller('staff-members')
export class StaffMembersController {
  constructor(private readonly staffList: StaffMemberListService) {}

  @Get()
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: StaffMemberListQueryDto,
  ): Promise<StaffMemberListResponseDto> {
    const result = await this.staffList.list(user.id, query);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /**
   * 직원 기본 정보. 목록 한 줄과 같은 모양이다. 없는 직원 · 관리 범위 밖 · 가려지는 직원(본사 제공 동의 없는 가맹
   * 점포 직원)은 모두 같은 404 다 — 퇴직 처리와 같은 규칙이다. 그래서 isMasked 는 늘 false 다.
   */
  @Get(':id')
  @ApiNotFoundResponse({
    description: '없는 직원 · 관리 범위 밖 · 가려지는 직원 · ID 형식 오류',
  })
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StaffMemberListItemDto> {
    const id = parseRouteId(rawId);
    const item = id && (await this.staffList.findOne(user.id, id));
    if (!item) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return item;
  }
}
