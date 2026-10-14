import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentStatus, EmploymentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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

/** `a,b` → `['a', 'b']`. 같은 이름을 여러 번 보낸 것(`?x=a&x=b`)도 같은 목록이 된다. 빈 칸은 그대로 남겨 검증이 막는다. */
const commaList = ({ value }: { value: unknown }) =>
  String(value)
    .split(',')
    .map((v) => v.trim());

/** 직원 목록 조회 (WHALEERP-329). */
export class StaffMemberListQueryDto {
  /** 페이지, 1부터. 상한은 OFFSET 이 DB 정수 범위를 넘어 500 이 되지 않게 둔다(200건 × 100만 쪽) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
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
   * 빈 칸 · 숫자가 아닌 값 · 1..2147483647 밖의 값이 하나라도 있거나 500개를 넘으면 400 이다.
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
   * 이름 부분 일치, 또는 하이픈을 뺀 휴대전화번호 부분 일치. 앞뒤 공백을 지우고 비면 없는 것으로 본다 — 빈
   * 검색창을 보낸 것만으로 개인 칸 필터가 되어 본사 역할의 가맹 점포 행이 빠지면 안 된다.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  /**
   * 쉼표로 구분한 고용형태. 없으면 전체. 화면은 둘 다 고르면 보내지 않는다.
   * 빈 값 · 모르는 값이 하나라도 있으면 400 이다.
   */
  @ApiPropertyOptional({ type: String, example: 'PART_TIME' })
  @IsOptional()
  @Transform(commaList)
  @ArrayMinSize(1)
  @IsEnum(EmploymentType, { each: true })
  employmentType?: EmploymentType[];

  /**
   * 쉼표로 구분한 가입·인증 상태(StaffJoinState). 고른 상태 중 하나라도 맞으면 나온다 — 화면의 묶음(초대 발송 =
   * INVITED,EXPIRED,REJECTED)을 그대로 보낸다. 없으면 전체. 빈 값 · 모르는 값이 하나라도 있으면 400 이다.
   * 화면에서 하나도 고르지 않았으면 이 api 를 부르지 않고 0건으로 그린다.
   */
  @ApiPropertyOptional({ type: String, example: 'INVITED,EXPIRED,REJECTED' })
  @IsOptional()
  @Transform(commaList)
  @ArrayMinSize(1)
  @IsIn(STAFF_JOIN_STATES, { each: true })
  joinState?: StaffJoinState[];

  /** 없으면 재직 · 퇴직 전체 */
  @ApiPropertyOptional({ enum: EmploymentStatus, enumName: 'EmploymentStatus' })
  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;
}
