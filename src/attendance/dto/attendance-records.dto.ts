import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AttendanceEntryMethod,
  AttendanceReviewReason,
  EmploymentStatus,
  EmploymentType,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { STORE_TYPES, type StoreType } from '../../stores/store-format';
import {
  ATTENDANCE_DAY_STATUS_LABELS,
  type AttendanceDayStatus,
} from '../attendance-day-status';

const MAX_ID = 2_147_483_647;
const DATE_MESSAGE = '날짜는 YYYY-MM-DD 형식의 있는 날짜입니다';

/** `a=1&a=2` 와 `a=1,2` 를 같은 배열로 받는다(TO-DO 목록 ListTodosQueryDto 와 같다). */
const splitComma = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',') : value;

/** splitComma 에 숫자 변환까지. @Type 은 @Transform 보다 먼저 돌아 쉼표로 나눈 조각을 숫자로 바꾸지 못한다. */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = splitComma({ value });
  return Array.isArray(parts)
    ? parts.map((p: unknown) =>
        typeof p === 'string' && p !== '' ? Number(p) : p,
      )
    : parts;
};

/**
 * 점포 조건 — 상단 점포 범위 ↔ 필터의 점포(데모 「출·퇴근 현황 조회」 필터, TO-DO 목록과 같은 규칙). 고른 점포(storeIds)와
 * 점포 유형(storeTypes)은 AND 이고 업무 범위 밖 점포는 늘 빠진다. 둘 다 주지 않으면 업무 범위 전체.
 */
export class AttendanceStoresQueryDto {
  /** 고른 점포. 여러 개는 `storeIds=1&storeIds=2` 와 쉼표 `storeIds=1,2` 중 하나로, 1000개까지 */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];

  /** 점포 유형(상단 범위 직영 · 가맹) — DIRECT · FRANCHISE. 폐점 점포는 뺀다 */
  @ApiPropertyOptional({ enum: STORE_TYPES, isArray: true })
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_TYPES, { each: true })
  storeTypes?: StoreType[];
}

export class DailyAttendanceQueryDto extends AttendanceStoresQueryDto {
  /** 날짜 YYYY-MM-DD(한국). 출근 기록 시각 · 근무스케줄 시작이 이 날인 것 */
  @IsDateOnly(DATE_MESSAGE)
  date: string;
}

export class PeriodAttendanceQueryDto extends AttendanceStoresQueryDto {
  /** 시작일 YYYY-MM-DD(한국) */
  @IsDateOnly(DATE_MESSAGE)
  from: string;

  /** 끝날 YYYY-MM-DD(포함). 시작부터 92일 이하 */
  @IsDateOnly(DATE_MESSAGE)
  to: string;

  /** 직원 레코드 — 주면 그 직원만. 점포 조건 안의 직원이 아니거나 본사에게 가려지는 직원이면 404 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId?: number;
}

/** 출근 또는 퇴근 한 번 */
export class AttendancePunchDto {
  attendanceRecordId: number;
  /** 기록 시각(ISO) */
  recordedAt: Date;
  /** 기록 시각 HH:mm(한국) */
  time: string;
  /** 확인 필요 사유 — 검토를 마치면 null */
  @ApiProperty({
    enum: AttendanceReviewReason,
    enumName: 'AttendanceReviewReason',
    nullable: true,
  })
  reviewReason: AttendanceReviewReason | null;
  @ApiProperty({
    enum: AttendanceEntryMethod,
    enumName: 'AttendanceEntryMethod',
  })
  entryMethod: AttendanceEntryMethod;
  /** 관리자가 보정한 적이 있는가(보정 이력이 있다) — 필터 「기록 구분 · 보정됨」 */
  isCorrected: boolean;
}

/** 출근과 그 짝 퇴근. 출근 없는 퇴근이면 checkIn 이 null */
export class AttendancePairDto {
  checkIn: AttendancePunchDto | null;
  checkOut: AttendancePunchDto | null;
}

export class AttendanceScheduleDto {
  /** HH:mm(한국) */
  startTime: string;
  /** HH:mm(한국). 자정을 넘으면 다음 날 시각 */
  endTime: string;
  breakMinutes: number;
}

/** 직원(레코드) · 날 한 줄. 본사 계정에게 가려지는 가맹 직원(ATT-30)은 줄이 없고 상태별 건수(`counts`)에만 센다 */
export class AttendanceDayItemDto {
  /** 날 YYYY-MM-DD(한국) */
  date: string;
  staffMemberId: number;
  name: string;
  /** 휴대전화번호 — 필터 「직원(이름 또는 번호)」 */
  phone: string;
  storeId: number;
  storeName: string;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  @ApiProperty({ enum: EmploymentStatus, enumName: 'EmploymentStatus' })
  employmentStatus: EmploymentStatus;
  schedules: AttendanceScheduleDto[];
  /** 출근순 */
  pairs: AttendancePairDto[];
  /** 그날 상태. 근무스케줄 시작 전이면 null(예정) */
  @ApiProperty({
    enum: Object.keys(ATTENDANCE_DAY_STATUS_LABELS),
    enumName: 'AttendanceDayStatus',
    nullable: true,
  })
  status: AttendanceDayStatus | null;
  /** 그날이 확정 · 발송된 급여명세서 기간 안이다 — 보정하면 급여에 영향이 갈 수 있다(WHALEERP-218 · 220) */
  isPayslipConfirmed: boolean;
}

export class DailyAttendanceResponseDto {
  date: string;
  /** 점포 · 이름순 */
  items: AttendanceDayItemDto[];
  /** 상태별 인원 — 가린 직원도 센다(ATT-30 「점포별 숫자에는 센다」) */
  counts: Record<AttendanceDayStatus, number>;
}

/** 근태 요약 — 한 직원의 한 주(급여 계산과 같은 규칙, 2026-10-23) */
export class AttendanceWeekStaffDto {
  staffMemberId: number;
  /** 근무 분 — 출근 ~ 짝 퇴근의 합에서 그날 근무스케줄 휴게(없으면 계약 휴게)를 뺀 것 */
  workedMinutes: number;
  /** 연장 분 — 정직원은 하루 8시간 · 주 40시간 초과, 파트타이머는 그 요일 계약 시간 초과(계약 안 한 요일은 전부)(PAY-04 우리 판단) */
  overtimeMinutes: number;
  /** 주휴 대상 — 1주 소정근로시간 15시간 이상이고 그 주 계약 요일을 모두 출근(PAY-02) */
  isWeeklyHolidayEligible: boolean;
}

/** 기간 조회의 하루 줄 — 보정이 필요한 기록의 「수정됨 08-30 정하윤」 · 「대신 등록 사유 · 정하윤」 꼬리를 위해 이력이 붙는다 */
export class AttendancePeriodItemDto extends AttendanceDayItemDto {
  /** 보정 · 대신 등록 이력, 새것부터. 손대지 않은 날 · 「이상 없음」만 받은 날은 빈 배열(ATT-19) */
  edits: AttendanceHistoryEntryDto[];
}

export class PeriodAttendanceResponseDto {
  from: string;
  to: string;
  /** 근무스케줄이나 기록이 있는 직원 · 날만(휴무는 없음). 날짜 내림차순, 같은 날은 점포 · 이름순 */
  items: AttendancePeriodItemDto[];
  /** 직원 · 날 상태별 건수 — 본사에게 가려지는 직원도 센다(ATT-30) */
  counts: Record<AttendanceDayStatus, number>;
  /**
   * 근태 요약의 직원별 한 주 값 — 기간이 월요일 ~ 일요일 한 주일 때만(아니면 없음). 급여 계산(WHALEERP-227)과 같은 규칙이다.
   * 줄에 나온 직원만(가려진 직원 없음)
   */
  weekStaff?: AttendanceWeekStaffDto[];
}

/** 이력 한 줄(데모 「○○ 출퇴근 기록 이력」) */
export class AttendanceHistoryEntryDto {
  /** 처리 일시 */
  at: Date;
  @ApiProperty({ enum: ['CORRECTION', 'PROXY'] })
  kind: 'CORRECTION' | 'PROXY';
  /** 처리한 관리자 — 이름(없으면 아이디) */
  by: string;
  /** 처리한 관리자의 권한 그룹 이름(데모 「정하윤 (BP 마스터)」). 계정을 찾지 못하면 null */
  byRole: string | null;
  /** 보정이면 변경 전 「출근 09:02 · 퇴근 없음」, 대신 등록이면 null */
  before: string | null;
  /** 보정이면 변경 후, 대신 등록이면 등록한 값 */
  after: string;
  reason: string;
}

export class MyAttendanceRecordsQueryDto {
  /** 앱 전역에서 고른 소속(직원 레코드) */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 시작일 YYYY-MM-DD(한국) */
  @IsDateOnly(DATE_MESSAGE)
  from: string;

  /** 끝날 YYYY-MM-DD(포함). 시작부터 366일 이하(HIST-2 「한 번에 최대 1년」) */
  @IsDateOnly(DATE_MESSAGE)
  to: string;
}

/** 직원 앱의 하루 — 관리자 웹 줄에 보정 · 대신 등록 이력(연필 시트, HIST-1)을 더했다 */
export class MyAttendanceDayDto extends AttendanceDayItemDto {
  /** 보정 · 대신 등록 이력, 새것부터. 손대지 않은 날 · 「이상 없음」만 받은 날은 빈 배열(ATT-19) */
  edits: AttendanceHistoryEntryDto[];
}

/** 근무 분 · 연장 분 — 급여 계산과 같은 값(휴게 뺌, 하루 8시간 · 주 40시간 초과 연장) */
export class MyAttendanceStatsDto {
  workedMinutes: number;
  overtimeMinutes: number;
}

/** 월 ~ 일 한 주의 근무 · 연장 — 기간 밖 날도 그 주면 센다 */
export class MyAttendanceWeekDto extends MyAttendanceStatsDto {
  /** 그 주 월요일(YYYY-MM-DD) */
  monday: string;
}

export class MyAttendanceRecordsResponseDto {
  from: string;
  to: string;
  storeName: string;
  /** 근무스케줄이나 기록이 있는 날만, 날짜순 */
  items: MyAttendanceDayDto[];
  /** 기간 합 */
  totals: MyAttendanceStatsDto;
  /** 기간에 걸친 주마다, 월요일순 */
  weeks: MyAttendanceWeekDto[];
}
