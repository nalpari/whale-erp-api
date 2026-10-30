import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FIRST_PUBLIC_HOLIDAY_YEAR,
  LAST_PUBLIC_HOLIDAY_YEAR,
} from '../public-holiday-years';

const YEAR_RANGE = '연도는 2000년부터 2050년까지 조회할 수 있습니다.';
const MONTH_RANGE = '월은 1~12 사이로 보내 주세요.';

/** 공식 휴일 조회 조건 — 캘린더는 연도 · 월, 목록은 연도만. */
export class ListPublicHolidaysQueryDto {
  /** 연도. 2000~2050(공식 휴일 테이블의 범위). @example 2026 */
  @Type(() => Number)
  @IsInt({ message: YEAR_RANGE })
  @Min(FIRST_PUBLIC_HOLIDAY_YEAR, { message: YEAR_RANGE })
  @Max(LAST_PUBLIC_HOLIDAY_YEAR, { message: YEAR_RANGE })
  year: number;

  /** 월 1~12. 주면 그 달(캘린더), 없으면 그 해 전체(목록). 목록은 키를 빼고 보낸다 — 빈 값(`month=`)은 400. @example 9 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: MONTH_RANGE })
  @Min(1, { message: MONTH_RANGE })
  @Max(12, { message: MONTH_RANGE })
  month?: number;
}
