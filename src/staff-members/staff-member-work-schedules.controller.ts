import {
  Controller,
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
import { StaffMemberWorkScheduleListQueryDto } from './dto/staff-member-work-schedule-list.query.dto';
import { StaffMemberWorkScheduleListResponseDto } from './dto/staff-member-work-schedule-list.response.dto';
import { StaffMemberWorkSchedulesService } from './staff-member-work-schedules.service';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

/**
 * 직원 상세의 근무스케줄 표(WHALEERP-185). 직원 정보 관리 조회 권한에 더해 근무스케줄 관리 조회 권한이 있어야 한다(서비스).
 * 응답 순서: 가드 403(직원 정보 관리 조회) → 쿼리 400 → ID 형식 404 → 영역 403(근무스케줄 관리 조회, 「조회 권한이
 * 없습니다.」) → 범위 404. 영역 403 은 형식이 맞는 어떤 ID 든 같다. 직원 상세 요약의 근무스케줄 영역(한 주)은 그대로 둔다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 정보 관리 조회 권한 없음(가드, 쿼리 · ID 검사보다 먼저) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 근무스케줄 관리 조회 권한 없음(「조회 권한이 없습니다.」, ID 형식 404 뒤 · 범위 404 앞 — 형식이 맞는 어떤 ID 든 같은 403)',
})
@ApiNotFoundResponse({
  description:
    'ID 형식 오류(쿼리 400 뒤 · 영역 403 앞) · 없는 직원 · 관리 범위 밖 · 가려지는 직원(영역 403 뒤)',
})
@MenuPermission('read')
@Controller('staff-members')
export class StaffMemberWorkSchedulesController {
  constructor(private readonly service: StaffMemberWorkSchedulesService) {}

  /** 이 직원의 근무스케줄 — 기간 필터 · 페이지. 근무일 내림차순, 같은 날은 시작 시각 순 */
  @Get(':id/work-schedules')
  @ApiBadRequestResponse({
    description:
      'period · page · pageSize 오류 — 가드 403 뒤, ID 형식 404 보다 먼저',
  })
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: StaffMemberWorkScheduleListQueryDto,
  ): Promise<StaffMemberWorkScheduleListResponseDto> {
    const id = parseRouteId(rawId);
    if (!id) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return this.service.list(user.id, id, query);
  }
}
