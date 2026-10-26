import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  LOCATION_CONSENT_STATE_LABELS,
  type LocationConsentState,
} from '../../my-profile/location-consent-state';
import {
  CHECK_IN_REVIEW_REASONS,
  CHECK_OUT_REVIEW_REASONS,
} from '../attendance-rules';

const MAX_ID = 2147483647;

export class MyAttendanceQueryDto {
  /** 앱 전역에서 고른 소속(직원 레코드) — `GET /me/memberships` 의 staffMemberId (ATT-07) */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;
}

export class CheckInDto {
  /** 앱 전역에서 고른 소속(직원 레코드) — 이 근무지로 출근한다(ATT-07) */
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 확인 필요 사유 — 고른 근무지 반경 밖이면 `OUT_OF_RADIUS_CHECKIN`(ATT-11). 좌표 · 거리는 받지 않는다(ATT-05) */
  @ApiProperty({ enum: CHECK_IN_REVIEW_REASONS, required: false })
  @IsOptional()
  @IsIn(CHECK_IN_REVIEW_REASONS)
  reviewReason?: (typeof CHECK_IN_REVIEW_REASONS)[number];

  /**
   * 출근 버튼을 누를 때 남긴 위치 읽음(`POST /me/attendance/location-reads` 의 locationReadId). 위치를 보는 근무지면 꼭 있어야 하고,
   * 그 확인자료(수집 · 이용)를 이 기록에 잇는다(ATT-22). 위치를 보지 않는 근무지는 보내지 않는다
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  locationReadId?: number;
}

export class CheckOutDto {
  /** 앱 전역에서 고른 소속 — 열린 출근 기록이 이 소속의 것이어야 한다 */
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 확인 필요 사유 — 반경 밖 `OUT_OF_RADIUS_CHECKOUT`, 위치 조작 감지 `MOCK_LOCATION`(ATT-11 · ATT-21). 좌표는 받지 않는다 */
  @ApiProperty({ enum: CHECK_OUT_REVIEW_REASONS, required: false })
  @IsOptional()
  @IsIn(CHECK_OUT_REVIEW_REASONS)
  reviewReason?: (typeof CHECK_OUT_REVIEW_REASONS)[number];

  /**
   * 퇴근 버튼을 누를 때 남긴 위치 읽음(`POST /me/attendance/location-reads` 의 locationReadId). 위치를 보는 근무지면 꼭 있어야 하고,
   * 그 확인자료(수집 · 이용)를 이 기록에 잇는다(ATT-22). 위치를 보지 않는 근무지는 보내지 않는다
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  locationReadId?: number;
}

export class LocationReadDto {
  /** 앱 전역에서 고른 소속 — 이 근무지로 출근 · 퇴근하려고 위치를 읽었다 */
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;
}

export class LocationReadResultDto {
  /** 이 읽음의 확인자료(수집) id — 이어서 보내는 출근 · 퇴근에 넣는다 */
  locationReadId: number;
}

/** 고른 근무지 — 앱이 휴대전화 안에서 거리를 재는 데 쓴다(ATT-05) */
export class AttendanceStoreDto {
  storeId: number;
  name: string;
  /** 기본주소와 상세주소 */
  address: string | null;
  /** 위도. 점포에 좌표가 없으면 null — 앱은 위치로 판정할 수 없다 */
  latitude: number | null;
  longitude: number | null;
  /** 근무지 반경(미터). 1차는 모든 점포 100 */
  radiusMeters: number;
  /** 위치 적용 여부 — false 면 위치를 보지 않고(동의 · 사유도 없음) 등록한다 */
  isLocationApplied: boolean;
}

/** 출근을 막는 까닭(ATT-12). 오늘(근무일)이 체결 완료 근로계약 기간 밖이다 */
export class CheckInBlockDto {
  @ApiProperty({ enum: ['CONTRACT_PENDING_SIGNATURE', 'NO_CONTRACT'] })
  reason: 'CONTRACT_PENDING_SIGNATURE' | 'NO_CONTRACT';
  /** 서명 대기 계약 — 「계약서 보기」로 연다. NO_CONTRACT 면 null */
  contractId: number | null;
}

/** 열린 출근 — 계정의 모든 소속에서 퇴근이 없는 출근 하나 */
export class OpenCheckInDto {
  attendanceRecordId: number;
  staffMemberId: number;
  storeId: number;
  storeName: string;
  recordedAt: Date;
}

/** 오늘(근무일) 근무스케줄 — 화면의 「오늘 예정 근무」 */
export class TodayScheduleDto {
  startAt: Date;
  endAt: Date;
  /** 시작 HH:mm(한국 시각) */
  startTime: string;
  /** 끝 HH:mm(한국 시각) */
  endTime: string;
  breakMinutes: number;
}

export class AttendanceConsentDto {
  @ApiProperty({
    enum: Object.keys(LOCATION_CONSENT_STATE_LABELS),
    enumName: 'LocationConsentState',
  })
  state: LocationConsentState;
  /** 동의한 약관 버전이 지금 시행 중인 것과 달라 다시 받아야 한다(ATT-23) */
  needsReconsent: boolean;
  /** 지금 시행 중인 위치정보 약관 버전 — 동의 시트의 「v1.2」. 없으면 null */
  termsVersion: string | null;
}

export class MyAttendanceResponseDto {
  staffMemberId: number;
  store: AttendanceStoreDto;
  locationConsent: AttendanceConsentDto;
  /** 출근을 막는 까닭. 출근할 수 있으면 null */
  checkInBlock: CheckInBlockDto | null;
  openCheckIn: OpenCheckInDto | null;
  todaySchedules: TodayScheduleDto[];
}

export class AttendanceRecordResultDto {
  attendanceRecordId: number;
  @ApiProperty({ enum: ['CHECK_IN', 'CHECK_OUT'] })
  kind: 'CHECK_IN' | 'CHECK_OUT';
  /** 기록 시각 — 서버가 요청을 받은 시각 */
  recordedAt: Date;
  storeId: number;
  storeName: string;
  @ApiProperty({
    enum: [...CHECK_IN_REVIEW_REASONS, ...CHECK_OUT_REVIEW_REASONS],
    nullable: true,
  })
  reviewReason: string | null;
  /** 퇴근일 때 짝 출근 시각. 출근이면 null */
  checkInRecordedAt: Date | null;
}
