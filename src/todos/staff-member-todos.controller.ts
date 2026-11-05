import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import {
  BP_FORBIDDEN_DESCRIPTION,
  BP_NOT_FOUND_DESCRIPTION,
} from '../contracts/contracts-swagger';
import { STAFF_BP_MISSING_404_DESCRIPTION } from '../staff-members/staff-target-bp';
import { STAFF_NOT_FOUND_MESSAGE } from '../staff-members/staff-menu';
import { TodoPageQueryDto } from './dto/list-todos-query.dto';
import { TodoItemListResponseDto } from './dto/todo.response.dto';
import { parseRouteId } from '../common/route-id';
import { TodosService } from './todos.service';

/**
 * 직원 상세의 TO-DO 영역(#118). 경로는 직원 자원 아래라 가드는 직원 정보 관리 조회를 보고, 서비스가 TO-DO 관리 조회를 다시
 * 본다 — 없으면 이 칸만 403 「조회 권한이 없습니다.」(직원 상세 요약과 같은 영역 규칙, 2026-10-22). 범위의 BP 는 가드가 정한
 * 탭 BP 다(`@TargetBp()`) — 플랫폼 계정이 헤더 없이 부르면 직원 단위라 404 다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: `직원 정보 관리 · TO-DO 관리 조회 권한 없음(TO-DO 관리는 「조회 권한이 없습니다.」) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · ${BP_FORBIDDEN_DESCRIPTION}`,
})
@Controller('staff-members')
export class StaffMemberTodosController {
  constructor(private readonly todos: TodosService) {}

  /** 그 직원에게 배정된 TO-DO. 정렬은 TO-DO 목록과 같다 */
  @Get(':id/todos')
  @MenuPermission('read')
  @ApiOkResponse({ type: TodoItemListResponseDto })
  @ApiNotFoundResponse({
    description: `없는 직원 · 관리 범위 밖 · 가려지는 직원 · ID 형식 오류 · ${STAFF_BP_MISSING_404_DESCRIPTION} · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  list(
    @Param('id') rawId: string,
    @Query() query: TodoPageQueryDto,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<TodoItemListResponseDto> {
    const id = parseRouteId(rawId);
    if (!id) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return this.todos.listForStaffMember(user.id, id, query, bp);
  }
}
