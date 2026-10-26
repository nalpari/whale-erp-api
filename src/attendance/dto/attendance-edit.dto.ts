import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import {
  AttendanceHistoryEntryDto,
  AttendanceStoresQueryDto,
} from './attendance-records.dto';

export { AttendanceHistoryEntryDto };

const MAX_ID = 2_147_483_647;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIME_MESSAGE = '시각은 HH:mm 형식입니다';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * 기록 보정(WHALEERP-218) — 한 직원의 그날 출근 · 퇴근 짝을 고친다. 시각은 그 짝의 날(출근한 날, 한국)의 HH:mm 이고, 퇴근이 출근
 * 보다 이르면 다음 날이다(밤샘). 비어 있던 쪽에 시각을 주면 그 기록을 새로 만든다(퇴근 미등록 · 출근 미등록 보정).
 */
export class CorrectAttendanceDto {
  /** 출근 HH:mm. 출근이 있으면 필수 — 지우지는 않는다 */
  @IsOptional()
  @Matches(TIME, { message: TIME_MESSAGE })
  checkInTime?: string;

  /** 퇴근 HH:mm. 퇴근이 있으면 필수 */
  @IsOptional()
  @Matches(TIME, { message: TIME_MESSAGE })
  checkOutTime?: string;

  /** 수정 사유 — 필수, 500자까지 */
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '수정 사유를 입력해 주세요' })
  @MaxLength(500)
  reason: string;

  /**
   * 화면이 본 출근 기록 시각(ISO) — 그사이 다른 관리자가 고쳤으면 409 ATTENDANCE_CHANGED. 출근이 없던 짝이면 생략
   */
  @IsOptional()
  @IsISO8601()
  expectedCheckInAt?: string;

  /** 화면이 본 퇴근 기록 시각(ISO). 퇴근이 없던 짝이면 생략 — 그사이 퇴근이 생겼어도 409 */
  @IsOptional()
  @IsISO8601()
  expectedCheckOutAt?: string;
}

/** 출퇴근 대신 등록(운영 정책 ATT-20 · 26) — 위치정보 동의를 거부 · 철회했거나 일시 중지한 직원만 */
export class ProxyAttendanceDto {
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 날 YYYY-MM-DD(한국). 최근 3개월 안 · 오늘까지 */
  @IsDateOnly('날짜는 YYYY-MM-DD 형식의 있는 날짜입니다')
  date: string;

  /** 출근 HH:mm — 필수 */
  @Matches(TIME, { message: TIME_MESSAGE })
  checkInTime: string;

  /** 퇴근 HH:mm. 없으면 출근만(열린 출근). 출근보다 이르면 다음 날 */
  @IsOptional()
  @Matches(TIME, { message: TIME_MESSAGE })
  checkOutTime?: string;

  /** 사유 — 필수, 500자까지 */
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '사유를 입력해 주세요' })
  @MaxLength(500)
  reason: string;
}

export class ProxyStaffQueryDto extends AttendanceStoresQueryDto {
  /** 날 YYYY-MM-DD(한국) */
  @IsDateOnly('날짜는 YYYY-MM-DD 형식의 있는 날짜입니다')
  date: string;
}

/** 대신 등록할 수 있는 직원 한 사람 */
export class ProxyStaffItemDto {
  staffMemberId: number;
  name: string;
  storeId: number;
  storeName: string;
  /** 그 날짜가 확정 · 발송된 급여명세서 기간 안이다 — 등록하기 전에 경고한다(218) */
  isPayslipConfirmed: boolean;
}

export class ProxyStaffResponseDto {
  items: ProxyStaffItemDto[];
}

/** 보정 · 대신 등록 · 이상 없음의 결과 */
export class AttendanceEditResultDto {
  /** 그 날짜가 확정 · 발송된 급여명세서 기간 안이다 — 급여에 영향이 갈 수 있다(218) */
  isPayslipConfirmed: boolean;
}

export class AttendanceHistoryResponseDto {
  items: AttendanceHistoryEntryDto[];
}
