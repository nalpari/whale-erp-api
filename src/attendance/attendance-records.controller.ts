import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { AttendanceEditService } from './attendance-edit.service';
import { AttendanceRecordsService } from './attendance-records.service';
import {
  AttendanceEditResultDto,
  AttendanceHistoryResponseDto,
  CorrectAttendanceDto,
  ProxyAttendanceDto,
  ProxyStaffQueryDto,
  ProxyStaffResponseDto,
} from './dto/attendance-edit.dto';
import {
  DailyAttendanceQueryDto,
  DailyAttendanceResponseDto,
  PeriodAttendanceQueryDto,
  PeriodAttendanceResponseDto,
} from './dto/attendance-records.dto';

/**
 * 관리자 웹 「출·퇴근 현황 조회」(WHALEERP-217 · 219). 메뉴는 `/attendance-records`(MN000025). 업무 범위(관리하는 점포) 밖은
 * 없는 것과 같다(404). 권한은 가드가 먼저 보고(403), 범위는 그 뒤 서비스가 본다(404).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '출·퇴근 현황 조회 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@Controller('attendance-records')
export class AttendanceRecordsController {
  constructor(
    private readonly records: AttendanceRecordsService,
    private readonly edit: AttendanceEditService,
  ) {}

  /**
   * 일별 출퇴근 — 점포 조건(상단 범위 · 필터) 안 하루의 직원별 예정 · 출근 · 퇴근 · 상태. 업무 범위 밖 점포는 빠진다. 본사 계정에게
   * 동의 없는 가맹 직원은 줄째로 빼고 건수에만 센다(ATT-30)
   */
  @Get('daily')
  @MenuPermission('read')
  @ApiOkResponse({ type: DailyAttendanceResponseDto })
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  daily(
    @Query() query: DailyAttendanceQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<DailyAttendanceResponseDto> {
    return this.records.daily(user.id, query, query.date);
  }

  /**
   * 기간 출퇴근 — 점포 조건 안 기간(92일 이하)의 직원 · 날 줄, 직원을 고르면 그 직원만(WHALEERP-217 「직원별 · 근무지별 · 기간」).
   * 근무스케줄이나 기록이 있는 날만. 본사 계정에게 동의 없는 가맹 직원은 빠지고 건수에만 센다(ATT-30)
   */
  @Get()
  @MenuPermission('read')
  @ApiOkResponse({ type: PeriodAttendanceResponseDto })
  @ApiBadRequestResponse({
    description: '쿼리 형식 오류 · 기간이 92일 넘음 · 끝이 시작보다 앞',
  })
  @ApiNotFoundResponse({
    description: '직원이 점포 조건 안의 직원이 아니거나 본사에게 가려진 직원',
  })
  period(
    @Query() query: PeriodAttendanceQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PeriodAttendanceResponseDto> {
    return this.records.period(
      user.id,
      query,
      query.from,
      query.to,
      query.staffMemberId ?? null,
    );
  }

  /** 대신 등록 선택지 — 그날 대신 등록할 수 있는 직원(위치정보 동의 없음 · 일시 중지, 체결 완료 계약, ATT-20 · 26) */
  @Get('proxy-staff')
  @MenuPermission('create')
  @ApiOkResponse({ type: ProxyStaffResponseDto })
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  proxyStaff(
    @Query() query: ProxyStaffQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ProxyStaffResponseDto> {
    return this.edit.proxyStaff(user.id, query, query.date);
  }

  /** 출퇴근 대신 등록(ATT-20 · 26). 최근 3개월 · 오늘까지, 사유 필수 */
  @Post('proxy')
  @MenuPermission('create')
  @ApiOkResponse({ type: AttendanceEditResultDto })
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({
    description:
      '본문 형식 오류 · 3개월이 지났거나 오늘 이후 · 아직 오지 않은 시각',
  })
  @ApiConflictResponse({
    description:
      'ALREADY_CHECKED_IN — 퇴근 없이 출근만 넣는데 열린 출근이 있음',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'PROXY_NOT_ALLOWED — 위치정보 동의가 있는 직원 · 위치를 보지 않는 점포 / NO_CONTRACT — 그날 체결 완료 계약 없음 · 퇴직 뒤',
  })
  proxy(
    @Body() dto: ProxyAttendanceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceEditResultDto> {
    return this.edit.proxy(user.id, dto);
  }

  /** 기록 보정 — 짝의 출근 · 퇴근 시각, 비었던 쪽은 새로. 보정 이력을 남기고 확인 필요 사유를 지운다(218 · ATT-19) */
  @Post(':recordId/correction')
  @MenuPermission('update')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AttendanceEditResultDto })
  @ApiBadRequestResponse({
    description:
      '본문 형식 오류 · 3개월이 지남 · 있던 쪽 시각을 비움 · 바뀐 값 없음 · 아직 오지 않은 시각',
  })
  @ApiNotFoundResponse({
    description: '없는 기록 · 업무 범위 밖 · 본사에게 가려진 직원',
  })
  @ApiConflictResponse({
    description: 'ATTENDANCE_CHANGED — 그사이 다른 관리자가 고침',
  })
  correct(
    @Param('recordId', ParseIntPipe) recordId: number,
    @Body() dto: CorrectAttendanceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceEditResultDto> {
    return this.edit.correct(user.id, recordId, dto);
  }

  /** 「이상 없음」 — 값은 그대로 두고 짝의 확인 필요 사유만 지운다(ATT-19) */
  @Post(':recordId/review')
  @MenuPermission('update')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AttendanceEditResultDto })
  @ApiNotFoundResponse({
    description: '없는 기록 · 업무 범위 밖 · 본사에게 가려진 직원',
  })
  @ApiConflictResponse({
    description: 'ATTENDANCE_CHANGED — 확인 필요 사유가 없음(이미 검토됨)',
  })
  review(
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceEditResultDto> {
    return this.edit.review(user.id, recordId);
  }

  /** 이력 — 짝의 보정 이력과 대신 등록, 새것부터 */
  @Get(':recordId/history')
  @MenuPermission('read')
  @ApiOkResponse({ type: AttendanceHistoryResponseDto })
  @ApiNotFoundResponse({
    description: '없는 기록 · 업무 범위 밖 · 본사에게 가려진 직원',
  })
  history(
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceHistoryResponseDto> {
    return this.edit.history(user.id, recordId);
  }
}
