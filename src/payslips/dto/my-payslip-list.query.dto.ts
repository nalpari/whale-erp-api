import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

const MAX_ID = 2_147_483_647;

/**
 * 직원 앱 명세서 목록 필터(PAY-10). 둘 다 목록(items)만 거른다 — 맨 위 이번 달 합계(thisMonth)와 점포 목록(stores)은
 * 필터와 관계없다.
 */
export class MyPayslipListQueryDto {
  /** 점포 ID. 명세서를 받은 적 없는 점포면 빈 목록이다 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId?: number;

  /** 연도 — 급여 기간 기준(2025년 12월 근무분을 2026년 1월에 받아도 2025년) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(9999)
  year?: number;
}
