import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

const YEAR_RANGE = '연도는 2000~2100 사이로 보내 주세요';
const MONTH_RANGE = '월은 1~12 사이로 보내 주세요';

/** 공식 휴일 조회 조건 — 캘린더는 연도 · 월, 목록은 연도만. */
export class ListPublicHolidaysQueryDto {
  /** 연도. 2000~2100(공식 휴일 테이블의 범위). @example 2026 */
  @Type(() => Number)
  @IsInt({ message: YEAR_RANGE })
  @Min(2000, { message: YEAR_RANGE })
  @Max(2100, { message: YEAR_RANGE })
  year: number;

  /** 월 1~12. 주면 그 달(캘린더), 없으면 그 해 전체(목록). @example 9 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: MONTH_RANGE })
  @Min(1, { message: MONTH_RANGE })
  @Max(12, { message: MONTH_RANGE })
  month?: number;
}
