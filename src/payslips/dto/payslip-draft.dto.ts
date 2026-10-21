import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';

const MAX_INT = 2_147_483_647;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MESSAGE = 'month 는 YYYY-MM 입니다';

/** 급여 월(YYYY-MM) 하나 — 작성 대상 조회 쿼리 · 일괄 작성 본문 (WHALEERP-226). 급여 기간은 그 달 1일 ~ 말일이다 */
export class PayslipMonthDto {
  @ApiProperty({ example: '2026-10' })
  @Matches(MONTH, { message: MONTH_MESSAGE })
  month: string;
}

/** 직원 한 명의 초안 작성 (WHALEERP-226) */
export class CreatePayslipDto {
  @IsInt()
  @Min(1)
  @Max(MAX_INT)
  staffMemberId: number;

  /** 급여 월(YYYY-MM). 급여 기간은 그 달 1일 ~ 말일이다 */
  @ApiProperty({ example: '2026-10' })
  @Matches(MONTH, { message: MONTH_MESSAGE })
  month: string;
}
