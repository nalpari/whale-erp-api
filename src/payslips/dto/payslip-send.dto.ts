import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_ID = 2_147_483_647;

/**
 * 그 달 확정 명세서 일괄 발송 (WHALEERP-231). 목록과 같은 점포 · 직원명 조건을 받아 목록의 「확정 N건」과 같은 대상을
 * 보낸다. 직원명으로 거르면 본사 역할에게 가린 직원 명세서는 대상에서 빠진다(목록과 같다).
 */
export class SendPayslipsDto {
  /** 급여 월(YYYY-MM) — 급여 기간 시작일이 그 달인 명세서 */
  @ApiProperty({ example: '2026-10' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month 는 YYYY-MM 입니다' })
  month: string;

  /** 점포 ID 목록. 관리 범위 밖은 조용히 빠진다. 없으면 관리 범위 전체 */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];

  /** 직원명 부분 일치(목록과 같다). 앞뒤 공백을 지우고 비면 없는 것으로 본다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  staffName?: string;
}
