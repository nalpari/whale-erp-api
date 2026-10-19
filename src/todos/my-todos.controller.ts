import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { ChangeTodoStatusDto } from './dto/change-todo-status.dto';
import { TodoPageQueryDto } from './dto/list-todos-query.dto';
import { TodoItemDto, TodoItemListResponseDto } from './dto/todo.response.dto';
import { TodoIdPipe } from './todo-id.pipe';
import { TodosService } from './todos.service';

/**
 * 직원 근무 앱의 내 TO-DO — 근무 탭과 홈 카드가 같이 쓴다. 내 재직 직원 레코드(그 점포에 체결 완료 근로계약이 있고 가입 완료 · 퇴직 전, 운영 정책 CTR-29)에 배정된 것만
 * 보이고, 그 밖의 TO-DO 는 없는 것과 같다(404).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/todos')
export class MyTodosController {
  constructor(private readonly todos: TodosService) {}

  /** 내 TO-DO. 근무지별로 묶을 때는 storeId 를 쓴다. 한 명 수행은 완료했으면 수행자 이름을 보인다(WORK-3) */
  @Get()
  @ApiOkResponse({ type: TodoItemListResponseDto })
  list(
    @Query() query: TodoPageQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoItemListResponseDto> {
    return this.todos.listMine(user.id, query);
  }

  /** 대기 ↔ 진행 중 ↔ 완료. 한 명 수행은 먼저 저장된 완료만 인정한다 */
  @Patch(':todoId/status')
  @ApiOkResponse({ type: TodoItemDto })
  @ApiNotFoundResponse({
    description:
      '내게 배정되지 않았거나 지운 TO-DO · 내 직원 레코드가 대상 조건(체결 완료 계약 · 가입 · 퇴직) 밖',
  })
  @ApiConflictResponse({
    description:
      'TODO_ALREADY_DONE(다른 직원이 먼저 완료 — performer 에 그 직원, 또는 본인이 완료한 것이 아닌 한 명 수행을 다시 열려 함) · TODO_STATUS_CONFLICT(그사이 상태가 바뀜)',
  })
  changeStatus(
    @Param('todoId', TodoIdPipe) todoId: number,
    @Body() body: ChangeTodoStatusDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TodoItemDto> {
    return this.todos.changeMyStatus(user.id, todoId, body.status);
  }
}
