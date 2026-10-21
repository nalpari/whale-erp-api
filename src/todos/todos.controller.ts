import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import {
  ChangeTodoStatusDto,
  TodoDeleteResponseDto,
} from './dto/change-todo-status.dto';
import { CreatedTodoResponseDto, CreateTodoDto } from './dto/create-todo.dto';
import {
  AssignableStaffQueryDto,
  AssignableStaffResponseDto,
} from './dto/assignable-staff.dto';
import { ListTodosQueryDto } from './dto/list-todos-query.dto';
import {
  TodoDetailDto,
  TodoItemDto,
  TodoListResponseDto,
} from './dto/todo.response.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { TodoIdPipe } from './todo-id.pipe';
import { TodosService } from './todos.service';

/**
 * 관리자 웹 「TO-DO 리스트 관리」(#109). 업무 범위(관리하는 점포) 밖 TO-DO 는 없는 것과 같다(404). 권한은 가드가
 * 먼저 보고(403), 범위는 그 뒤 서비스가 본다(404).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    'TO-DO 리스트 관리 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@Controller('todos')
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  /** 목록. 미완료 긴급 → 미완료 나머지 → 완료, 묶음 안은 수행 예정 일시 오름차순. 배정 그룹은 한 줄 */
  @Get()
  @MenuPermission('read')
  @ApiOkResponse({ type: TodoListResponseDto })
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  list(
    @Query() query: ListTodosQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoListResponseDto> {
    return this.todos.list(user.id, query);
  }

  /** 등록의 직원 고르기 — 그 근무지에 체결 완료 계약이 있고 가입을 마쳤고 퇴직하지 않은 직원, 이름순 */
  @Get('assignable-staff')
  @MenuPermission('create')
  @ApiOkResponse({ type: AssignableStaffResponseDto })
  @ApiBadRequestResponse({ description: 'storeId 형식 오류' })
  @ApiNotFoundResponse({ description: '근무지 점포가 없거나 업무 범위 밖' })
  assignableStaff(
    @Query() query: AssignableStaffQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AssignableStaffResponseDto> {
    // 이 경로는 `:todoId` 보다 앞에 둔다 — 뒤에 두면 TodoIdPipe 가 assignable-staff 를 ID 로 읽어 404 를 낸다.
    return this.todos.assignableStaff(user.id, query.storeId);
  }

  /** 상세 — 배정 대상 · 상태 이력, 그룹이면 직원별 상태 */
  @Get(':todoId')
  @MenuPermission('read')
  @ApiOkResponse({ type: TodoDetailDto })
  @ApiNotFoundResponse({ description: '없는 TO-DO · 지움 · 업무 범위 밖' })
  findOne(
    @Param('todoId', TodoIdPipe) todoId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoDetailDto> {
    return this.todos.findOne(user.id, todoId);
  }

  /** 등록. 배정 그룹을 펼쳐 행을 만든다. 배정 알림은 없다 */
  @Post()
  @MenuPermission('create')
  @ApiCreatedResponse({ type: CreatedTodoResponseDto })
  @ApiBadRequestResponse({
    description:
      '입력 오류 · 지난 날짜 · 배정 대상과 수행 방식이 맞지 않음 · 퇴직했거나 체결 완료 계약이 없거나 가입 전이거나 다른 근무지 직원 · 그런 재직 직원 없음',
  })
  @ApiNotFoundResponse({ description: '근무지 점포가 없거나 업무 범위 밖' })
  create(
    @Body() body: CreateTodoDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedTodoResponseDto> {
    return this.todos.create(user.id, body);
  }

  /** 제목 · 내용 · 수행 예정 일시 · 긴급 수정. 그룹이면 그룹 전체. 배정 대상 · 수행 방식은 못 바꾼다(400) */
  @Patch(':todoId')
  @MenuPermission('update')
  @ApiOkResponse({ type: TodoDetailDto })
  @ApiBadRequestResponse({
    description: '입력 오류 · 지난 날짜 · 바꿀 수 없는 칸',
  })
  @ApiNotFoundResponse({ description: '없는 TO-DO · 지움 · 업무 범위 밖' })
  update(
    @Param('todoId', TodoIdPipe) todoId: number,
    @Body() body: UpdateTodoDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoDetailDto> {
    return this.todos.update(user.id, todoId, body);
  }

  /** 관리자가 직원 대신 상태를 바꾼다(T-1). 그룹이면 그 행만 */
  @Patch(':todoId/status')
  @MenuPermission('update')
  @ApiOkResponse({ type: TodoItemDto })
  @ApiNotFoundResponse({ description: '없는 TO-DO · 지움 · 업무 범위 밖' })
  @ApiConflictResponse({
    description: 'TODO_ALREADY_DONE · TODO_STATUS_CONFLICT(그사이 상태가 바뀜)',
  })
  changeStatus(
    @Param('todoId', TodoIdPipe) todoId: number,
    @Body() body: ChangeTodoStatusDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoItemDto> {
    return this.todos.changeStatus(user.id, todoId, body.status);
  }

  /** 대기만 지운다. 그룹이면 그룹의 대기인 행만(T-2) */
  @Delete(':todoId')
  @MenuPermission('delete')
  @ApiOkResponse({ type: TodoDeleteResponseDto })
  @ApiNotFoundResponse({ description: '없는 TO-DO · 지움 · 업무 범위 밖' })
  @ApiConflictResponse({ description: '지울 대기 TO-DO 가 없음' })
  remove(
    @Param('todoId', TodoIdPipe) todoId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoDeleteResponseDto> {
    return this.todos.remove(user.id, todoId);
  }
}
