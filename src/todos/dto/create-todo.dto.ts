import { ApiProperty } from '@nestjs/swagger';
import { TodoAssigneeType, TodoExecutionMode } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { NO_NUL } from '../../common/no-nul';

const MAX_ID = 2_147_483_647;
export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const TIME_MESSAGE = '수행 시간은 HH:mm 입니다';
export const DATE_MESSAGE =
  '수행 예정 날짜는 YYYY-MM-DD 형식의 있는 날짜입니다';

/** 제목 · 내용 · 수행 예정 일시 · 긴급 — 등록과 수정이 같은 규칙을 쓴다 */
export class TodoFieldsDto {
  /** 제목. 100자까지 */
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: '제목을 입력해 주세요' })
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title: string;

  /** 내용. 2,000자까지. 앞뒤 공백을 지우고, 비면(공백만이면) null */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_NUL, { message: '내용에 쓸 수 없는 문자가 있습니다' })
  body?: string | null;

  /** 수행 예정 날짜 YYYY-MM-DD. 한국 날짜로 오늘 이후 */
  @IsDateOnly(DATE_MESSAGE)
  dueDate: string;

  /** 수행 시간 HH:mm(한국 시각). 없으면 날짜만 */
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  dueTime?: string | null;

  /** 긴급. 기본 false */
  @IsOptional()
  @IsBoolean()
  isUrgent?: boolean;
}

/**
 * TO-DO 등록. 배정 그룹을 펼쳐 행을 만든다 — 개인은 직원마다 1행(여러 명이면 같은 그룹), 근무지 전체 · 각자 수행은
 * 지금 재직자마다 1행(같은 그룹), 근무지 전체 · 한 명 수행은 대상 전원을 배정한 공유 1행이다.
 */
export class CreateTodoDto extends TodoFieldsDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId: number;

  /** 배정 대상 — 개인 · 근무지 전체. 등록 뒤 바꾸지 않는다 */
  @ApiProperty({ enum: TodoAssigneeType, enumName: 'TodoAssigneeType' })
  @IsEnum(TodoAssigneeType)
  assigneeType: TodoAssigneeType;

  /** 수행 방식 — 각자 수행 · 한 명 수행. 근무지 전체면 필수, 개인이면 각자 수행만(빼면 각자 수행). 등록 뒤 바꾸지 않는다 */
  @ApiProperty({
    enum: TodoExecutionMode,
    enumName: 'TodoExecutionMode',
    required: false,
  })
  @IsOptional()
  @IsEnum(TodoExecutionMode)
  executionMode?: TodoExecutionMode;

  /** 개인 배정의 직원 레코드. 개인이면 1~200명, 근무지 전체면 넣지 않는다. 그 근무지의 재직 직원이어야 한다 */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  staffMemberIds?: number[];
}

export class CreatedTodoResponseDto {
  /** 만든 행. 개인 한 명 · 한 명 수행은 하나 */
  todoIds: number[];
  /** 배정 그룹 ID. 행이 하나면 null */
  assignmentGroupId: number | null;
}
