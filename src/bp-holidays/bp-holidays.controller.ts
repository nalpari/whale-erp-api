import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { kstToday } from '../staff-members/kst-date';
import { BpHolidayCallerService } from './bp-holiday-caller.service';
import { BpHolidayChangesService } from './bp-holiday-changes.service';
import { BpHolidaysService, NOT_FOUND } from './bp-holidays.service';
import {
  BpHolidayCreatedResponseDto,
  BpHolidayDetailResponseDto,
  BpHolidayHistoryListResponseDto,
  BpHolidayListResponseDto,
  BpHolidayOverlapsResponseDto,
} from './dto/bp-holiday.response.dto';
import {
  BpHolidayDetailQueryDto,
  ListBpHolidayHistoriesQueryDto,
  ListBpHolidaysQueryDto,
} from './dto/list-bp-holidays-query.dto';
import {
  CheckBpHolidayOverlapsDto,
  DeleteBpHolidayQueryDto,
  SaveBpHolidayDto,
  TerminateBpHolidayDto,
  UpdateBpHolidayDto,
} from './dto/save-bp-holiday.dto';

const bpHolidayIdOf = (raw: string): number => {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException(NOT_FOUND);
  return id;
};

/**
 * BP 휴일 관리(MN000015, `/bp-holidays`). 메뉴는 경로로 찾고(@MenuPermission), 대상 BP 는 X-Bp-Code-Id →
 * `@TargetBp()` 다 — 플랫폼 계정은 BP 를 골라야 하고(없으면 400) 고른 BP 를 BP 마스터와 같은 범위로 다룬다.
 * 조회는 read, 등록은 create, 수정은 update, 강제 종료 · 삭제는 delete 다. 겹침 확인은 등록 · 수정 화면이 부르므로
 * create 또는 update 다.
 *
 * 「오늘」은 한국 날짜다(CONFIG-9). 날짜 규칙과 변경 정책은 okf `api/bp-holidays.md`.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '쓸 수 없는 계정 · 메뉴 권한 없음 · 다른 BP 헤더 · 일부 점포 사용자의 전체 점포 휴일 · 맡지 않은 점포',
})
@ApiBadRequestResponse({
  description: '쿼리 · 본문 검증 실패 · 플랫폼 계정의 BP 미선택',
})
@UserTypes('admin')
@Controller('bp-holidays')
export class BpHolidaysController {
  constructor(
    private readonly callers: BpHolidayCallerService,
    private readonly holidays: BpHolidaysService,
    private readonly changes: BpHolidayChangesService,
  ) {}

  /** 월 캘린더 · 목록 — 계산한 날짜마다 한 줄과, 캘린더의 공식 휴일. */
  @Get()
  @MenuPermission('read')
  async list(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListBpHolidaysQueryDto,
  ): Promise<BpHolidayListResponseDto> {
    const caller = await this.callers.load(user.id, bp);
    return this.holidays.list(caller, query, kstToday());
  }

  /** 변경 이력 — 기간(기본 이달 1일~오늘)에 생긴 등록 · 수정 · 강제 종료 · 삭제. 지운 휴일 포함. */
  @Get('histories')
  @MenuPermission('read')
  async histories(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListBpHolidayHistoriesQueryDto,
  ): Promise<BpHolidayHistoryListResponseDto> {
    const caller = await this.callers.load(user.id, bp);
    return this.holidays.histories(caller, query, kstToday());
  }

  /** 겹치는 휴일 확인 — 저장 전에 부른다. 저장은 막지 않는다. */
  @Post('overlaps')
  @MenuPermission(['create', 'update'])
  @HttpCode(HttpStatus.OK)
  async overlaps(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: CheckBpHolidayOverlapsDto,
  ): Promise<BpHolidayOverlapsResponseDto> {
    const caller = await this.callers.load(user.id, bp);
    return this.holidays.overlaps(caller, body, kstToday());
  }

  @Get(':bpHolidayId')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: '없는 · 지운 · 볼 수 없는 휴일' })
  async detail(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('bpHolidayId') rawId: string,
    @Query() query: BpHolidayDetailQueryDto,
  ): Promise<BpHolidayDetailResponseDto> {
    const id = bpHolidayIdOf(rawId);
    const caller = await this.callers.load(user.id, bp);
    return this.holidays.detail(caller, id, query.date, kstToday());
  }

  @Post()
  @MenuPermission('create')
  async create(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: SaveBpHolidayDto,
  ): Promise<BpHolidayCreatedResponseDto> {
    const caller = await this.callers.load(user.id, bp);
    return this.changes.create(caller, body, kstToday());
  }

  /** 수정 — 시작 전이면 모두, 진행 중이면 휴일명 · 설명 · 점포만. 점포는 더하면 오늘부터, 빼면 어제까지. */
  @Put(':bpHolidayId')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 · 지운 · 볼 수 없는 휴일' })
  @ApiConflictResponse({
    description:
      '끝난 휴일 · 진행 중 휴일의 날짜 · 유형 · 반복 · 적용 범위 변경 · 다른 사용자가 먼저 수정',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('bpHolidayId') rawId: string,
    @Body() body: UpdateBpHolidayDto,
  ): Promise<void> {
    const id = bpHolidayIdOf(rawId);
    const caller = await this.callers.load(user.id, bp);
    await this.changes.update(caller, id, body, kstToday());
  }

  /** 강제 종료 — 어제 날짜로 끝낸다. 되돌리지 않는다. 시작일이 어제 이전인 진행 중 휴일만. */
  @Post(':bpHolidayId/terminate')
  @MenuPermission('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 · 지운 · 볼 수 없는 휴일' })
  @ApiConflictResponse({
    description:
      '끝난 휴일 · 오늘 이후에 시작하는 휴일(삭제를 쓴다) · 다른 사용자가 먼저 수정',
  })
  async terminate(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('bpHolidayId') rawId: string,
    @Body() body: TerminateBpHolidayDto,
  ): Promise<void> {
    const id = bpHolidayIdOf(rawId);
    const caller = await this.callers.load(user.id, bp);
    await this.changes.terminate(caller, id, body.updatedAt, kstToday());
  }

  /** 삭제(논리) — 시작일이 오늘 이후인 휴일만. 지운 휴일은 변경 이력에만 남는다. */
  @Delete(':bpHolidayId')
  @MenuPermission('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 · 지운 · 볼 수 없는 휴일' })
  @ApiConflictResponse({
    description:
      '이미 지난 날짜가 있는 휴일(강제 종료를 쓴다) · 다른 사용자가 먼저 수정',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('bpHolidayId') rawId: string,
    @Query() query: DeleteBpHolidayQueryDto,
  ): Promise<void> {
    const id = bpHolidayIdOf(rawId);
    const caller = await this.callers.load(user.id, bp);
    await this.changes.remove(caller, id, query.updatedAt, kstToday());
  }
}
