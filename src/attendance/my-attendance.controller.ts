import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  AttendanceRecordResultDto,
  CheckInDto,
  CheckOutDto,
  LocationReadDto,
  LocationReadResultDto,
  MyAttendanceQueryDto,
  MyAttendanceResponseDto,
} from './dto/my-attendance.dto';
import { AttendanceRecordsService } from './attendance-records.service';
import {
  MyAttendanceRecordsQueryDto,
  MyAttendanceRecordsResponseDto,
} from './dto/attendance-records.dto';
import { MyAttendanceService } from './my-attendance.service';

const NOT_MINE =
  '내 소속이 아님 — 없는 id, 남의 레코드, 퇴직했거나 체결 완료 근로계약이 없는 내 레코드. 모두 같은 본문';
const CONSENT =
  'LOCATION_CONSENT_REQUIRED — 위치정보 동의 없음 · 철회 · 약관 버전이 바뀌어 다시 동의 필요 / LOCATION_PAUSED — 위치 수집 일시 중지. 위치를 보지 않는 근무지는 보지 않는다';

/**
 * 직원 근무 앱 출퇴근 등록(WHALEERP-207 · 210 · 211 · 212). 근무지는 앱 전역에서 고른 소속 하나다(ATT-07). 위치 판정은
 * 휴대전화가 하고, 좌표 · 거리는 보내지 않는다 — 반경 밖 · 위치 조작 감지면 확인 필요 사유만 붙인다(ATT-05 · ATT-11).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: `관리자 토큰 · ${CONSENT}` })
@UserTypes('account')
@Controller('me/attendance')
export class MyAttendanceController {
  constructor(
    private readonly attendance: MyAttendanceService,
    private readonly records: AttendanceRecordsService,
  ) {}

  /** 출퇴근 화면 — 고른 근무지의 좌표 · 반경(1차 모두 100m), 동의 상태, 출근을 막는 까닭, 열린 출근, 오늘 근무스케줄 */
  @Get()
  @ApiOkResponse({ type: MyAttendanceResponseDto })
  @ApiBadRequestResponse({ description: 'staffMemberId 형식 오류' })
  @ApiNotFoundResponse({ description: NOT_MINE })
  get(
    @Query() query: MyAttendanceQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MyAttendanceResponseDto> {
    return this.attendance.get(user.id, query.staffMemberId);
  }

  /**
   * 위치 읽음(ATT-22) — 출근 · 퇴근 버튼을 눌러 위치를 읽을 때마다 부른다. 확인자료(수집 · 이용)를 남기고, 받은 locationReadId 를
   * 이어서 보내는 출근 · 퇴근에 넣는다. 위치는 보내지 않는다
   */
  @Post('location-reads')
  @ApiCreatedResponse({ type: LocationReadResultDto })
  @ApiBadRequestResponse({
    description: '본문 형식 오류 · 위치를 보지 않는 근무지',
  })
  @ApiNotFoundResponse({ description: NOT_MINE })
  locationRead(
    @Body() dto: LocationReadDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LocationReadResultDto> {
    return this.attendance.locationRead(user.id, dto);
  }

  /** 출근. 기록 시각은 서버가 받은 시각이다 */
  @Post('check-in')
  @ApiCreatedResponse({ type: AttendanceRecordResultDto })
  @ApiBadRequestResponse({
    description:
      '본문 형식 오류 · 출근에 쓸 수 없는 사유 · 위치를 보지 않는 근무지에 사유 · 위치 읽음 · 위치를 보는 근무지인데 위치 읽음이 없거나 이미 쓴 것',
  })
  @ApiNotFoundResponse({ description: NOT_MINE })
  @ApiConflictResponse({
    description:
      'ALREADY_CHECKED_IN — 어느 소속에든 열린 출근이 있음(openCheckIn 을 함께)',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'CONTRACT_PENDING_SIGNATURE — 서명 대기 계약(contractId) / NO_CONTRACT — 오늘이 체결 완료 근로계약 기간 밖이거나 퇴직일이 지남 (ATT-12)',
  })
  checkIn(
    @Body() dto: CheckInDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceRecordResultDto> {
    return this.attendance.checkIn(user.id, dto);
  }

  /** 퇴근. 고른 소속의 열린 출근을 닫는다 */
  @Post('check-out')
  @ApiCreatedResponse({ type: AttendanceRecordResultDto })
  @ApiBadRequestResponse({
    description:
      '본문 형식 오류 · 퇴근에 쓸 수 없는 사유 · 위치를 보지 않는 근무지에 사유 · 위치 읽음 · 위치를 보는 근무지인데 위치 읽음이 없거나 이미 쓴 것',
  })
  @ApiNotFoundResponse({ description: NOT_MINE })
  @ApiConflictResponse({
    description:
      'NO_OPEN_CHECK_IN — 고른 소속에 열린 출근이 없음. 다른 소속에 있으면 openCheckIn 을 함께. CHECK_OUT_EXPIRED — 열린 출근이 출근한 다음 날을 지남(관리자 보정으로 닫는다)',
  })
  checkOut(
    @Body() dto: CheckOutDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceRecordResultDto> {
    return this.attendance.checkOut(user.id, dto);
  }

  /**
   * 출퇴근 현황(WHALEERP-221 · 222) — 내 소속 하나의 기간(366일 이하) 기록. 보기만 한다(고치기는 관리자 웹뿐). 보정 · 대신 등록한 날에는
   * 이력이 붙는다(연필 시트)
   */
  @Get('records')
  @ApiOkResponse({ type: MyAttendanceRecordsResponseDto })
  @ApiForbiddenResponse({
    description: '관리자 토큰 — 위치 동의는 보지 않는다',
  })
  @ApiBadRequestResponse({
    description: '쿼리 형식 오류 · 기간이 366일 넘음 · 끝이 시작보다 앞',
  })
  @ApiNotFoundResponse({ description: NOT_MINE })
  myRecords(
    @Query() query: MyAttendanceRecordsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MyAttendanceRecordsResponseDto> {
    return this.records.mine(
      user.id,
      query.staffMemberId,
      query.from,
      query.to,
    );
  }
}
