import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MyWorkScheduleListResponseDto,
  MyWorkSchedulesQueryDto,
} from './dto/work-schedule.dto';
import { WorkSchedulesService } from './work-schedules.service';

/**
 * 직원 근무 앱 근무 탭의 「근무스케줄」 월 달력(#205, WORK-1). 보기만 한다 — 고치기는 관리자 웹 근무스케줄 관리뿐이다.
 * 근무지는 앱 전역에서 고른 소속 하나다(WORK-4).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/work-schedules')
export class MyWorkSchedulesController {
  constructor(private readonly schedules: WorkSchedulesService) {}

  /** 내 소속 하나의 한 달 근무스케줄, 시작순. 앞달 말일에 시작해 1일로 넘어온 근무는 앞달 것이다 */
  @Get()
  @ApiOkResponse({ type: MyWorkScheduleListResponseDto })
  @ApiBadRequestResponse({ description: 'staffMemberId · month 형식 오류' })
  @ApiNotFoundResponse({
    description:
      '내 소속이 아님 — 없는 id, 남의 레코드, 퇴직했거나 체결 완료 근로계약이 없는 내 레코드. 모두 같은 본문',
  })
  list(
    @Query() query: MyWorkSchedulesQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MyWorkScheduleListResponseDto> {
    return this.schedules.listMine(user.id, query.staffMemberId, query.month);
  }
}
