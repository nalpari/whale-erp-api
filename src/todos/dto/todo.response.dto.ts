import { ApiProperty } from '@nestjs/swagger';
import {
  TodoAssigneeType,
  TodoExecutionMode,
  TodoStatus,
} from '@prisma/client';

export class TodoStaffDto {
  staffMemberId: number;
  staffMemberName: string;
}

/** 관리자 웹 목록의 한 줄. 배정 그룹은 필터에 맞는 행을 한 줄로 묶는다 */
export class TodoListItemDto {
  /** 그 줄에 남은 행(필터에 맞고 지우지 않은 행) 가운데 첫 행. 상세를 열 때 쓴다 */
  todoId: number;
  /** 그룹이 아니면 null */
  assignmentGroupId: number | null;
  storeId: number;
  /** 점포가 지워졌어도 이름은 보인다 */
  storeName: string | null;
  title: string;
  @ApiProperty({ enum: TodoAssigneeType, enumName: 'TodoAssigneeType' })
  assigneeType: TodoAssigneeType;
  @ApiProperty({ enum: TodoExecutionMode, enumName: 'TodoExecutionMode' })
  executionMode: TodoExecutionMode;
  /** YYYY-MM-DD */
  @ApiProperty({ example: '2026-10-20' })
  dueDate: string;
  /** HH:mm. 날짜만이면 null */
  @ApiProperty({ example: '18:00', nullable: true, type: String })
  dueTime: string | null;
  isUrgent: boolean;
  /** 이 줄의 상태 — 그룹이면 모두 완료 = 완료, 모두 대기 = 대기, 그 밖은 진행 중 */
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  status: TodoStatus;
  /** 이 줄에 묶인 행 수 */
  todoCount: number;
  /** 그 가운데 완료한 행 수 */
  doneCount: number;
  /** 배정된 직원. 한 명 수행은 대상 전원 */
  assignees: TodoStaffDto[];
  /** 한 명 수행을 먼저 완료한 직원 */
  @ApiProperty({ type: TodoStaffDto, nullable: true })
  performer: TodoStaffDto | null;
  createdAt: Date;
}

export class TodoListResponseDto {
  items: TodoListItemDto[];
  /** 거른 결과의 줄 수(그룹은 한 줄) */
  total: number;
}

/** 배정 대상 한 사람 */
export class TodoAssigneeDto extends TodoStaffDto {
  isCompleted: boolean;
  @ApiProperty({ nullable: true, type: Date })
  completedAt: Date | null;
}

/** 그룹의 직원별 상태 */
export class TodoGroupRowDto {
  todoId: number;
  /** 퇴직으로 배정이 풀린 행은 null */
  @ApiProperty({ nullable: true, type: Number })
  staffMemberId: number | null;
  @ApiProperty({ nullable: true, type: String })
  staffMemberName: string | null;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  status: TodoStatus;
  @ApiProperty({ nullable: true, type: Date })
  completedAt: Date | null;
}

/** 상태 이력 한 줄. 바꾼 사람은 관리자(changedBy)나 직원(staffMemberId) 중 하나다 */
export class TodoStatusHistoryDto {
  /** 등록 때 줄은 null */
  @ApiProperty({
    enum: TodoStatus,
    enumName: 'TodoStatus',
    nullable: true,
  })
  fromStatus: TodoStatus | null;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  toStatus: TodoStatus;
  /** 긴급 표시를 바꾼 줄 */
  isUrgentChanged: boolean;
  @ApiProperty({ nullable: true, type: Number })
  changedBy: number | null;
  @ApiProperty({ nullable: true, type: String })
  changedByName: string | null;
  @ApiProperty({ nullable: true, type: Number })
  staffMemberId: number | null;
  @ApiProperty({ nullable: true, type: String })
  staffMemberName: string | null;
  /** 퇴직으로 배정이 풀린 직원 */
  @ApiProperty({ nullable: true, type: Number })
  unassignedStaffMemberId: number | null;
  @ApiProperty({ nullable: true, type: String })
  unassignedStaffMemberName: string | null;
  changedAt: Date;
}

/** 관리자 웹 상세 */
export class TodoDetailDto {
  todoId: number;
  @ApiProperty({ nullable: true, type: Number })
  assignmentGroupId: number | null;
  storeId: number;
  @ApiProperty({ nullable: true, type: String })
  storeName: string | null;
  title: string;
  @ApiProperty({ nullable: true, type: String })
  body: string | null;
  @ApiProperty({ enum: TodoAssigneeType, enumName: 'TodoAssigneeType' })
  assigneeType: TodoAssigneeType;
  @ApiProperty({ enum: TodoExecutionMode, enumName: 'TodoExecutionMode' })
  executionMode: TodoExecutionMode;
  @ApiProperty({ example: '2026-10-20' })
  dueDate: string;
  @ApiProperty({ example: '18:00', nullable: true, type: String })
  dueTime: string | null;
  isUrgent: boolean;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  status: TodoStatus;
  @ApiProperty({ nullable: true, type: Date })
  completedAt: Date | null;
  @ApiProperty({ type: TodoStaffDto, nullable: true })
  performer: TodoStaffDto | null;
  createdBy: number;
  @ApiProperty({ nullable: true, type: String })
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** 이 행의 배정 대상 */
  assignees: TodoAssigneeDto[];
  /** 그룹의 행들(이 행 포함). 그룹이 아니면 빈 배열 */
  groupTodos: TodoGroupRowDto[];
  /** 이 행의 상태 이력, 최신순 */
  histories: TodoStatusHistoryDto[];
}

/** 직원 근무 앱 · 직원 상세의 한 행 */
export class TodoItemDto {
  todoId: number;
  storeId: number;
  @ApiProperty({ nullable: true, type: String })
  storeName: string | null;
  title: string;
  @ApiProperty({ nullable: true, type: String })
  body: string | null;
  @ApiProperty({ enum: TodoAssigneeType, enumName: 'TodoAssigneeType' })
  assigneeType: TodoAssigneeType;
  @ApiProperty({ enum: TodoExecutionMode, enumName: 'TodoExecutionMode' })
  executionMode: TodoExecutionMode;
  @ApiProperty({ example: '2026-10-20' })
  dueDate: string;
  @ApiProperty({ example: '18:00', nullable: true, type: String })
  dueTime: string | null;
  isUrgent: boolean;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  status: TodoStatus;
  @ApiProperty({ nullable: true, type: Date })
  completedAt: Date | null;
  /** 한 명 수행을 완료한 직원 — 근무지 동료에게 이름을 보인다(WORK-3) */
  @ApiProperty({ type: TodoStaffDto, nullable: true })
  performer: TodoStaffDto | null;
}

export class TodoItemListResponseDto {
  items: TodoItemDto[];
  total: number;
}
