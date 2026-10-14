import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import { StaffMemberListResponseDto } from './dto/staff-member-list.response.dto';
import { StaffMemberListService } from './staff-member-list.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';

/**
 * 직원 정보 관리 목록 (WHALEERP-329). 관리자 웹만 쓴다 — 직원 앱 토큰은 403. 관리 범위 밖 점포는 storeIds 로
 * 골라도 조용히 빠진다(오류를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@ApiBadRequestResponse({ description: '쿼리 형식 오류' })
@UserTypes('admin')
@Controller('staff-members')
export class StaffMembersController {
  constructor(private readonly staffList: StaffMemberListService) {}

  @Get()
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: StaffMemberListQueryDto,
  ): Promise<StaffMemberListResponseDto> {
    const result = await this.staffList.list(user.id, query);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }
}
