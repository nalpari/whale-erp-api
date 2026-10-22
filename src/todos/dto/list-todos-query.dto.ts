import { ApiPropertyOptional } from '@nestjs/swagger';
import { TodoAssigneeType, TodoStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { STORE_TYPES, type StoreType } from '../../stores/store-format';

const MAX_ID = 2_147_483_647;
const DATE_MESSAGE = '기간은 YYYY-MM-DD 형식의 있는 날짜입니다';

/** `a=1&a=2` 와 `a=1,2` 를 같은 배열로 받는다(점포 목록 ListStoresQueryDto 와 같다). */
const splitComma = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',') : value;

/** splitComma 에 숫자 변환까지. @Type 은 @Transform 보다 먼저 돌아 쉼표로 나눈 조각을 숫자로 바꾸지 못한다. */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = splitComma({ value });
  return Array.isArray(parts)
    ? parts.map((p: unknown) =>
        typeof p === 'string' && p !== '' ? Number(p) : p,
      )
    : parts;
};

/** 직원 근무 앱 · 직원 상세가 같이 쓰는 조건 */
export class TodoPageQueryDto {
  /** 1부터 */
  // 기본값이 있어 빼도 된다 — 플러그인은 `?` 가 없으면 필수로 적는다.
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;

  /** 근무지 점포 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId?: number;

  /** 여러 개면 `?status=PENDING&status=IN_PROGRESS`. 없으면 전체 */
  @ApiPropertyOptional({
    enum: TodoStatus,
    enumName: 'TodoStatus',
    isArray: true,
  })
  @IsOptional()
  // 하나만 오면 쿼리 파서가 배열이 아니라 문자열로 준다.
  @Transform(({ value }: { value: unknown }): unknown[] =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsEnum(TodoStatus, { each: true })
  status?: TodoStatus[];

  /** 수행 예정 날짜 시작(그날 포함) YYYY-MM-DD */
  @IsOptional()
  @IsDateOnly(DATE_MESSAGE)
  dueDateFrom?: string;

  /** 수행 예정 날짜 끝(그날 포함) YYYY-MM-DD */
  @IsOptional()
  @IsDateOnly(DATE_MESSAGE)
  dueDateTo?: string;
}

/**
 * 관리자 웹 TO-DO 목록 조건. 점포는 상단 점포 범위 ↔ 목록 점포 필터 연동(1팀 front #88)을 따라 고른 점포(storeIds)와 점포
 * 유형(storeTypes)으로도 거른다 — storeId · storeIds · storeTypes 는 모두 AND 이고 업무 범위 밖 점포는 늘 빠진다.
 */
export class ListTodosQueryDto extends TodoPageQueryDto {
  /** 고른 점포. 여러 개는 `storeIds=1&storeIds=2` 또는 쉼표로, 1000개까지. 주지 않으면 업무 범위 전체 */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];

  /** 점포 유형 — DIRECT 직영 · FRANCHISE 가맹. 여러 개는 반복하거나 쉼표로. 주지 않으면 둘 다 */
  @ApiPropertyOptional({ enum: STORE_TYPES, isArray: true })
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_TYPES, { each: true })
  storeTypes?: StoreType[];

  /** 담당 — 개인 · 근무지 전체 */
  @ApiPropertyOptional({ enum: TodoAssigneeType, enumName: 'TodoAssigneeType' })
  @IsOptional()
  @IsEnum(TodoAssigneeType)
  assigneeType?: TodoAssigneeType;

  /** 이 직원 레코드에 배정된 것 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId?: number;

  /** true · false. 없으면 전체 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isUrgent?: boolean;
}
