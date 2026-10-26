import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { NO_NUL } from '../../common/no-nul';
import { trimText } from '../../platform-admins/platform-admin-format';

const YEAR_RANGE = '연도는 2000~2100 사이로 보내 주세요';
const MONTH_RANGE = '월은 1~12 사이로 보내 주세요';
const DATE = '날짜는 YYYY-MM-DD 로 보내 주세요';

/** 월 캘린더 · 목록(WHALEERP-553). 고른 달 하나만 본다 — 기간 조건은 받지 않는다(CONFIG-8). */
export class ListBpHolidaysQueryDto {
  /** 연도 2000~2100. @example 2026 */
  @Type(() => Number)
  @IsInt({ message: YEAR_RANGE })
  @Min(2000, { message: YEAR_RANGE })
  @Max(2100, { message: YEAR_RANGE })
  year: number;

  /** 월 1~12. @example 10 */
  @Type(() => Number)
  @IsInt({ message: MONTH_RANGE })
  @Min(1, { message: MONTH_RANGE })
  @Max(12, { message: MONTH_RANGE })
  month: number;

  /** 휴일명에 들어 있으면 나온다(캘린더 · 목록 모두). @example 정기 */
  @IsOptional()
  @IsString()
  @Transform(trimText)
  @MaxLength(30)
  @Matches(NO_NUL, { message: '쓸 수 없는 문자가 있습니다' })
  name?: string;
}

/** 상세(WHALEERP-554). 고른 날짜는 「다음 날짜」의 기준이다 — 없으면 오늘. */
export class BpHolidayDetailQueryDto {
  /** 캘린더 · 목록에서 고른 날짜. @example 2026-10-26 */
  @IsOptional()
  @IsDateOnly(DATE)
  date?: string;
}

/** 변경 이력(WHALEERP-555). 기간은 이력이 생긴 날짜(한국)로, 기본은 이달 1일부터 오늘까지. */
export class ListBpHolidayHistoriesQueryDto {
  /** 시작 날짜. @example 2026-10-01 */
  @IsOptional()
  @IsDateOnly(DATE)
  from?: string;

  /** 끝 날짜(그날 포함). @example 2026-10-26 */
  @IsOptional()
  @IsDateOnly(DATE)
  to?: string;

  /** 1부터. @example 1 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  /** 기본 20, 최대 200. @example 20 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;
}
