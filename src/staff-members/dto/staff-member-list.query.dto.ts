import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentStatus, EmploymentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { STAFF_JOIN_STATES, type StaffJoinState } from '../join-state';

const MAX_ID = 2_147_483_647;

/** 직원 목록 조회 (WHALEERP-329). */
export class StaffMemberListQueryDto {
  /** 페이지, 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 페이지당 건수, 기본 20 · 최대 200 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  /**
   * 쉼표로 구분한 점포 ID. 관리 범위 밖의 ID 는 조용히 빠진다. 없으면 관리 범위 전체.
   * 빈 칸 · 숫자가 아닌 값 · 범위 밖 값이 하나라도 있으면 400 이다.
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

  /** 이름 부분 일치, 또는 하이픈을 뺀 휴대전화번호 부분 일치 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @ApiPropertyOptional({ enum: EmploymentType, enumName: 'EmploymentType' })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiPropertyOptional({ enum: STAFF_JOIN_STATES, enumName: 'StaffJoinState' })
  @IsOptional()
  @IsIn(STAFF_JOIN_STATES)
  joinState?: StaffJoinState;

  /** 없으면 재직 · 퇴직 전체 */
  @ApiPropertyOptional({ enum: EmploymentStatus, enumName: 'EmploymentStatus' })
  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;
}
