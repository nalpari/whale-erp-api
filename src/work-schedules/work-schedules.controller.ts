import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  PipeTransform,
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
import { parseRouteId } from '../common/route-id';
import {
  CreateWorkScheduleDto,
  UpdateWorkScheduleDto,
  WorkScheduleDefaultsDto,
  WorkScheduleDefaultsQueryDto,
  WorkScheduleDeleteResponseDto,
  WorkScheduleDto,
  WorkScheduleStaffQueryDto,
  WorkScheduleStaffResponseDto,
} from './dto/work-schedule.dto';
import { WorkSchedulesService } from './work-schedules.service';

/** 경로의 workScheduleId. integer 범위 밖이면 DB 에 묻기 전에 404 다(CLAUDE.md 「id 는 integer」). */
@Injectable()
export class WorkScheduleIdPipe implements PipeTransform<string, number> {
  transform(raw: string): number {
    const id = parseRouteId(raw);
    if (id === null)
      throw new NotFoundException('근무스케줄을 찾을 수 없습니다');
    return id;
  }
}

const NOT_SCHEDULABLE =
  '입력 오류 · 24시간짜리 · 휴게가 근무시간 이상 · WORK_SCHEDULE_NO_CONTRACT(근무일에 체결 완료 계약 없음) · WORK_SCHEDULE_AFTER_RETIREMENT(퇴직일 뒤) · WORK_SCHEDULE_NOT_JOINED(가입 전) · 본사에게 가려지는 가맹 직원';

/**
 * 관리자 웹 「근무스케줄 관리」(#198). 메뉴는 `/work-schedules`. 업무 범위(관리하는 점포) 밖은 없는 것과 같다(404).
 * 권한은 가드가 먼저 보고(403), 범위는 그 뒤 서비스가 본다(404).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '근무스케줄 관리 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@Controller('work-schedules')
export class WorkSchedulesController {
  constructor(private readonly schedules: WorkSchedulesService) {}

  /** 등록의 직원 선택지 — 가입을 마쳤고 그 근무일에 체결 완료 계약이 있고 퇴직일 전인 직원, 이름순(STAFF-29 · CTR-24) */
  @Get('assignable-staff')
  @MenuPermission('create')
  @ApiOkResponse({ type: WorkScheduleStaffResponseDto })
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  @ApiNotFoundResponse({ description: '근무지 점포가 없거나 업무 범위 밖' })
  assignableStaff(
    @Query() query: WorkScheduleStaffQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkScheduleStaffResponseDto> {
    return this.schedules.assignableStaff(
      user.id,
      query.storeId,
      query.workDate,
    );
  }

  /** 기본값 — 근무일 요일의 계약 근무시간(STAFF-14). 「계약 값으로 되돌리기」도 이것을 부른다 */
  @Get('defaults')
  @MenuPermission(['create', 'update'])
  @ApiOkResponse({ type: WorkScheduleDefaultsDto })
  @ApiBadRequestResponse({ description: NOT_SCHEDULABLE })
  @ApiNotFoundResponse({ description: '직원이 없거나 업무 범위 밖' })
  defaults(
    @Query() query: WorkScheduleDefaultsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkScheduleDefaultsDto> {
    return this.schedules.defaults(
      user.id,
      query.staffMemberId,
      query.workDate,
    );
  }

  /** 등록. 종료가 시작보다 이르면 다음 날(자정 넘김). 겹치지 않으면 같은 날 여러 건 */
  @Post()
  @MenuPermission('create')
  @ApiCreatedResponse({ type: WorkScheduleDto })
  @ApiBadRequestResponse({ description: NOT_SCHEDULABLE })
  @ApiNotFoundResponse({ description: '직원이 없거나 업무 범위 밖' })
  @ApiConflictResponse({
    description: 'WORK_SCHEDULE_OVERLAP(같은 직원 근무스케줄과 겹침)',
  })
  create(
    @Body() body: CreateWorkScheduleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkScheduleDto> {
    return this.schedules.create(user.id, body);
  }

  /** 수정. 근무일 · 시각 · 휴게. 직원은 못 바꾼다. 지난 날짜도 경고 없이 */
  @Patch(':workScheduleId')
  @MenuPermission('update')
  @ApiOkResponse({ type: WorkScheduleDto })
  @ApiBadRequestResponse({ description: NOT_SCHEDULABLE })
  @ApiNotFoundResponse({ description: '없는 근무스케줄 · 지움 · 업무 범위 밖' })
  @ApiConflictResponse({
    description: 'WORK_SCHEDULE_OVERLAP(같은 직원 근무스케줄과 겹침)',
  })
  update(
    @Param('workScheduleId', WorkScheduleIdPipe) workScheduleId: number,
    @Body() body: UpdateWorkScheduleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkScheduleDto> {
    return this.schedules.update(user.id, workScheduleId, body);
  }

  /** 삭제. 시점 제한 없이 */
  @Delete(':workScheduleId')
  @MenuPermission('delete')
  @ApiOkResponse({ type: WorkScheduleDeleteResponseDto })
  @ApiNotFoundResponse({ description: '없는 근무스케줄 · 지움 · 업무 범위 밖' })
  remove(
    @Param('workScheduleId', WorkScheduleIdPipe) workScheduleId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkScheduleDeleteResponseDto> {
    return this.schedules.remove(user.id, workScheduleId);
  }
}
