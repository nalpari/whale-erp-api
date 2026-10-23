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
import { INT4_MAX } from '../../platform-admins/platform-admin-format';
import { STORE_TYPES, type StoreType } from '../../stores/store-format';
import { STAFF_JOIN_STATES, type StaffJoinState } from '../join-state';

/** `a,b` → `['a', 'b']`. 같은 이름을 여러 번 보낸 것(`?x=a&x=b`)도 같은 목록이 된다. 빈 칸은 그대로 남겨 검증이 막는다. */
const commaList = ({ value }: { value: unknown }) =>
  String(value)
    .split(',')
    .map((v) => v.trim());

/** `a=1&a=2` · `a=1,2` · 둘을 섞은 `a=1,2&a=3` 을 모두 같은 배열로 받는다(근로계약 목록 ListContractsQueryDto 와 같다). */
const splitComma = ({ value }: { value: unknown }): unknown =>
  (Array.isArray(value) ? value : [value]).flatMap((v: unknown) =>
    typeof v === 'string' ? v.split(',') : [v],
  );

/** splitComma 에 숫자 변환까지. 숫자만 받는다 — `0x10` · `1e3` · 빈 조각 · 공백은 NaN 으로 두어 검증이 막는다(400). */
const splitNumbers = ({ value }: { value: unknown }): unknown =>
  (splitComma({ value }) as unknown[]).map((p) =>
    typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : NaN,
  );

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
   * 고른 점포(관리자웹 목록 점포 필터 · 상단 점포 범위). 쉼표로 1000개까지(`storeIds=1,2`). 같은 키 반복
   * (`storeIds=1&storeIds=2`)도 받지만 쿼리 파서가 키를 1000개까지만 읽어 넘치면 뒤 조건이 400 없이 빠지므로 많을 때는
   * 쉼표로 보낸다(api #132 리뷰). 관리 범위 밖의 id 는 조용히 빠진다. 주지 않으면 관리 범위 전체.
   * 빈 칸 · 숫자가 아닌 값 · 1..2147483647 밖의 값이 하나라도 있거나 1000개를 넘으면 400 이다.
   */
  @ApiPropertyOptional({ type: [Number], example: [3, 5] })
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /**
   * 점포 유형(상단 점포 범위의 직영 · 가맹) — DIRECT · FRANCHISE, 반복하거나 쉼표로. 주면 그 유형 점포만이고 폐점 점포는
   * 뺀다(TO-DO 목록 api #133 과 같다, 2026-10-22 재영 — 폐점 점포는 전체 · 점포를 골라 본다). storeIds 와 함께 주면 둘 다
   * 맞는 점포만이다. 주지 않으면 유형 · 폐점 무관. 빈 값 · 모르는 값이 하나라도 있으면 400 이다.
   */
  @ApiPropertyOptional({ enum: STORE_TYPES, isArray: true })
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_TYPES, { each: true })
  storeTypes?: StoreType[];

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
