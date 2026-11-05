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
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
  StaffMemberDetailResponseDto,
  StaffMemberListResponseDto,
} from './dto/staff-member-list.response.dto';
import { StaffMemberListService } from './staff-member-list.service';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';
import { STAFF_BP_MISSING_404_DESCRIPTION } from './staff-target-bp';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import {
  BP_FORBIDDEN_DESCRIPTION,
  BP_MISSING_DESCRIPTION,
  BP_NOT_FOUND_DESCRIPTION,
} from '../contracts/contracts-swagger';

/**
 * 직원 정보 관리 목록 (WHALEERP-329) · 상세 (WHALEERP-599). 관리자 웹만 쓰고, 직원 정보 관리 조회 권한이 있어야
 * 한다 — 직원 앱 토큰 · 권한 없는 관리자는 403. 관리 범위 밖 점포는 storeIds 로 골라도 조용히 빠진다(오류를 주면
 * 다른 BP 에 그 점포가 있다는 것이 드러난다). 다루는 직원의 BP 는 가드가 X-Bp-Code-Id 로 정한다(`@TargetBp()`) — BP · 가맹
 * 계정은 소속 BP, 플랫폼 계정은 헤더로 고른 고객 BP 의 점포 전부다. 헤더가 없으면 목록은 400, 상세는 404 다(근로계약과 같다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: `직원 정보 관리 조회 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · ${BP_FORBIDDEN_DESCRIPTION}`,
})
@MenuPermission('read')
@Controller('staff-members')
export class StaffMembersController {
  constructor(private readonly staffList: StaffMemberListService) {}

  @Get()
  @ApiBadRequestResponse({
    description: `쿼리 형식 오류 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: StaffMemberListQueryDto,
    @TargetBp() bp: TargetBpContext,
  ): Promise<StaffMemberListResponseDto> {
    const result = await this.staffList.list(user.id, query, bp);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /**
   * 직원 기본 정보. 목록 한 줄에 계정 이메일을 더한 모양이다. 없는 직원 · 관리 범위 밖 · 가려지는
   * 직원(본사 제공 동의 없는 가맹 점포 직원)은 모두 같은 404 다 — 퇴직 처리와 같은 규칙이다. 그래서 isMasked 는 늘
   * false 다.
   */
  @Get(':id')
  @ApiNotFoundResponse({
    description: `없는 직원 · 관리 범위 밖 · 가려지는 직원 · ID 형식 오류 · ${STAFF_BP_MISSING_404_DESCRIPTION} · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @TargetBp() bp: TargetBpContext,
  ): Promise<StaffMemberDetailResponseDto> {
    const id = parseRouteId(rawId);
    const item = id && (await this.staffList.findOne(user.id, id, bp));
    if (!item) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return item;
  }
}
