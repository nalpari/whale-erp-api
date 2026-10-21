import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayslipStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const PAYSLIP_PAGE_SIZES = [20, 50, 100] as const;

const MAX_ID = 2_147_483_647;

/** 급여명세서 목록 조회 (WHALEERP-330). 근무지는 관리자의 관리 범위(업무 범위) 안에서 storeIds 로 좁힌다. */
export class PayslipListQueryDto {
  /** 급여 월(YYYY-MM). 급여 기간 시작일이 그 달인 명세서다 */
  @ApiProperty({ example: '2026-09' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month 는 YYYY-MM 입니다' })
  month: string;

  /**
   * 쉼표로 구분한 명세서 상태. 없으면 전체. 빈 값 · 모르는 값이 하나라도 있으면 400 이다. 상태 건수(statusCounts)는
   * 이 값과 상관없이 그 달 전체로 센다.
   */
  @ApiPropertyOptional({ type: String, example: 'REVIEWING,CONFIRMED' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    String(value)
      .split(',')
      .map((v) => v.trim()),
  )
  @ArrayMinSize(1)
  @IsEnum(PayslipStatus, { each: true })
  status?: PayslipStatus[];

  /**
   * 쉼표로 구분한 점포 ID(직원 목록과 같다). 관리 범위 밖의 ID 는 조용히 빠진다. 없으면 관리 범위 전체.
   * 빈 칸 · 숫자가 아닌 값 · 1..2147483647 밖의 값이 하나라도 있거나 500개를 넘으면 400 이다. 상태 건수도 이 점포로 센다.
   */
  @ApiPropertyOptional({ type: String, example: '3,5,8' })
  @IsOptional()
  @Transform(({ value }) =>
    String(value)
      .split(',')
      .map((v) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)),
  )
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];

  /**
   * 직원명 부분 일치(대소문자 무시, `%` · `_` 는 글자 그대로). 앞뒤 공백을 지우고 비면 없는 것으로 본다. 주면 본사 역할에게
   * 가린 줄(본사 제공 동의 없는 가맹 점포 직원)은 목록 · 상태 건수에서 빠진다 — 이름 검색으로 가린 직원이 드러나지 않게.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  staffName?: string;

  /** 페이지, 1부터. 상한은 OFFSET 이 DB 정수 범위를 넘어 500 이 되지 않게 둔다 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 페이지당 건수 — 20 · 50 · 100, 기본 20 */
  @ApiPropertyOptional({ enum: PAYSLIP_PAGE_SIZES, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(PAYSLIP_PAGE_SIZES)
  pageSize?: number;
}
