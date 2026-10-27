import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { NO_NUL } from '../../common/no-nul';
import { IsUpdatedAt } from '../../common/updated-at';
import {
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  HOLIDAY_TYPES,
  REPEAT_END_TYPES,
  REPEAT_TYPES,
} from '../bp-holiday-rule';

const DATE = '날짜는 YYYY-MM-DD 로 보내 주세요';

/**
 * BP 휴일 등록 양식(WHALEERP-557). 유형과 맞지 않는 칸은 보내도 무시하고 비운다 — 하루는 종료일 = 시작일, 반복은
 * 종료일 없이 반복 칸만. 칸 사이의 규칙(기간의 종료일, 반복의 종료 조건)은 서비스가 본다.
 */
export class SaveBpHolidayDto {
  /** 휴일명 1~30자. @example 정기휴무 */
  @IsString()
  @Transform(trimText)
  @Length(1, 30, { message: '휴일명은 1~30자로 보내 주세요' })
  @Matches(NO_NUL, { message: '쓸 수 없는 문자가 있습니다' })
  name: string;

  /** 설명 500자까지. 비우면 null. @example 월요일마다 쉬는 정기 휴무 */
  @IsOptional()
  @IsString()
  @Transform(trimText)
  @MaxLength(500, { message: '설명은 500자까지 보내 주세요' })
  @Matches(NO_NUL, { message: '쓸 수 없는 문자가 있습니다' })
  description?: string | null;

  /** 휴일 유형(공통코드 HOLIDAY_TYPE) — DAY 하루 · PERIOD 기간 · REPEAT 반복. @example REPEAT */
  @IsIn(HOLIDAY_TYPES, {
    message: '휴일 유형은 DAY · PERIOD · REPEAT 중 하나입니다',
  })
  holidayTypeCode: (typeof HOLIDAY_TYPES)[number];

  /** 시작일(반복의 기준일). 오늘(한국 날짜) 이후. @example 2026-11-02 */
  @IsDateOnly(DATE)
  startDate: string;

  /** 기간의 종료일. 하루 · 반복은 무시한다. @example 2026-11-04 */
  @IsOptional()
  @IsDateOnly(DATE)
  endDate?: string | null;

  /** 반복 유형(공통코드 HOLIDAY_REPEAT_TYPE) — 반복일 때만. @example WEEKLY */
  @IsOptional()
  @IsIn(REPEAT_TYPES, {
    message: '반복 유형은 DAILY · WEEKLY · MONTHLY · YEARLY 중 하나입니다',
  })
  holidayRepeatTypeCode?: (typeof REPEAT_TYPES)[number] | null;

  /** 반복 종료 조건 — NONE 없음 · UNTIL_DATE 특정 날짜까지 · COUNT 지정 횟수만큼. @example NONE */
  @IsOptional()
  @IsIn(REPEAT_END_TYPES, {
    message: '종료 조건은 NONE · UNTIL_DATE · COUNT 중 하나입니다',
  })
  repeatEndType?: (typeof REPEAT_END_TYPES)[number] | null;

  /** 반복 종료일 — UNTIL_DATE 일 때만. @example 2026-12-28 */
  @IsOptional()
  @IsDateOnly(DATE)
  repeatEndDate?: string | null;

  /** 반복 횟수 1~9999 — COUNT 일 때만. 없는 날짜(31일 · 2월 29일)는 세지 않는다. @example 10 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '반복 횟수는 1~9999 로 보내 주세요' })
  @Min(1, { message: '반복 횟수는 1~9999 로 보내 주세요' })
  @Max(9999, { message: '반복 횟수는 1~9999 로 보내 주세요' })
  repeatCount?: number | null;

  /** 전체 점포 휴일인가. true 면 예외 점포(excludedStoreIds), false 면 대상 점포(storeIds)를 받는다. @example false */
  @IsBoolean()
  isAllStores: boolean;

  /** 특정 점포 휴일의 대상 점포 — 하나 이상, 1000개까지. @example [3] */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /** 전체 점포 휴일의 예외 점포 — 이 휴일에서 빠진다. 1000개까지. @example [] */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  excludedStoreIds?: number[];
}

/**
 * BP 휴일 수정 양식 — 등록과 같은 칸에 읽은 updatedAt 을 더한다. 진행 중인 휴일은 휴일명 · 설명 · 점포만 바뀌고,
 * 날짜 · 유형 · 반복 · 적용 범위는 읽은 값 그대로 보내야 한다(바꾸면 409).
 */
export class UpdateBpHolidayDto extends SaveBpHolidayDto {
  /** 상세에서 읽은 updatedAt — 그 뒤 다른 사용자가 고쳤으면 409. @example 2026-10-26T01:00:00.000Z */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 강제 종료 — 읽은 updatedAt 만 받는다. 종료일은 언제나 어제(한국 날짜)다. */
export class TerminateBpHolidayDto {
  /** 상세에서 읽은 updatedAt. @example 2026-10-26T01:00:00.000Z */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 삭제 — 읽은 updatedAt 을 쿼리로 받는다(`DELETE /bp-holidays/:id?updatedAt=…`). 지운 휴일은 되살릴 수 없다. */
export class DeleteBpHolidayQueryDto {
  /** 상세에서 읽은 updatedAt. @example 2026-10-26T01:00:00.000Z */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 겹치는 휴일 확인 — 등록 · 수정 양식 그대로. 수정이면 고치는 휴일 자신은 빼고 본다. */
export class CheckBpHolidayOverlapsDto extends SaveBpHolidayDto {
  /** 수정 중인 휴일. 등록이면 비운다. @example 12 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  bpHolidayId?: number;
}
