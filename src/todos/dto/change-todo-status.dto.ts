import { ApiProperty } from '@nestjs/swagger';
import { TodoStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

/** 상태 변경 — 대기 · 진행 중 · 완료 */
export class ChangeTodoStatusDto {
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  @IsEnum(TodoStatus)
  status: TodoStatus;
}

export class TodoDeleteResponseDto {
  /** 지운 행 수 */
  deleted: number;
  /** 그룹에 남은 행 수 — 진행 중 · 완료라 지우지 않은 것 */
  remaining: number;
}
