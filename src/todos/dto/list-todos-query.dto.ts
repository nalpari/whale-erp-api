import { ApiPropertyOptional } from '@nestjs/swagger';
import { TodoAssigneeType, TodoStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';

const MAX_ID = 2_147_483_647;
const DATE_MESSAGE = '기간은 YYYY-MM-DD 형식의 있는 날짜입니다';

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

/** 관리자 웹 TO-DO 목록 조건 */
export class ListTodosQueryDto extends TodoPageQueryDto {
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
