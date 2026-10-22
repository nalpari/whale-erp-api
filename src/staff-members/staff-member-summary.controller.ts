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
import {
  StaffMemberContractSummaryResponseDto,
  StaffMemberPayslipSummaryResponseDto,
  StaffMemberTodoSummaryResponseDto,
  StaffMemberWeekScheduleResponseDto,
} from './dto/staff-member-summary.response.dto';
import { StaffMemberWeekQueryDto } from './dto/staff-member-week.query.dto';
import { StaffMemberSummaryService } from './staff-member-summary.service';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

const idOf = (raw: string): number => {
  const id = parseRouteId(raw);
  if (!id) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
  return id;
};

/**
 * 직원 상세 요약(WHALEERP-183). 영역마다 경로가 따로라 한 영역이 실패해도 나머지는 그대로 온다. 직원 정보 관리 조회
 * 권한에 더해 그 영역 메뉴(근로계약 · 근무스케줄 · 급여명세서 · TO-DO)의 조회 권한이 있어야 하고, 없으면 그 영역만
 * 「조회 권한이 없습니다.」 403 이다. 출퇴근 현황은 기록을 쌓는 곳이 아직 없어 영역이 없다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 정보 관리 · 그 영역 메뉴의 조회 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@ApiNotFoundResponse({
  description: '없는 직원 · 관리 범위 밖 · 가려지는 직원 · ID 형식 오류',
})
@MenuPermission('read')
@Controller('staff-members')
export class StaffMemberSummaryController {
  constructor(private readonly summary: StaffMemberSummaryService) {}

  /** 근로계약 영역 — 가장 최근 계약의 유형 · 기간 · 상태 · 최근 발송일 · 갱신 예정일. 근로계약 관리 조회 권한 */
  @Get(':id/summary/contracts')
  async contract(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StaffMemberContractSummaryResponseDto> {
    return this.summary.contract(user.id, idOf(rawId));
  }

  /** 근무스케줄 영역 — 한 주(월~일)의 근무스케줄과 주간 근무시간. 근무스케줄 관리 조회 권한 */
  @Get(':id/summary/work-schedules')
  @ApiBadRequestResponse({ description: 'weekStart 형식 오류' })
  async workSchedules(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: StaffMemberWeekQueryDto,
  ): Promise<StaffMemberWeekScheduleResponseDto> {
    return this.summary.workSchedules(user.id, idOf(rawId), query.weekStart);
  }

  /** 급여명세서 영역 — 최근 명세서 3건 · 미발송 건수. 급여명세서 관리 조회 권한 */
  @Get(':id/summary/payslips')
  async payslips(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StaffMemberPayslipSummaryResponseDto> {
    return this.summary.payslips(user.id, idOf(rawId));
  }

  /** TO-DO 영역 — 전체 · 완료 · 미완료 건수와 최근 처리 이력. TO-DO 관리 조회 권한 */
  @Get(':id/summary/todos')
  async todos(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StaffMemberTodoSummaryResponseDto> {
    return this.summary.todos(user.id, idOf(rawId));
  }
}
