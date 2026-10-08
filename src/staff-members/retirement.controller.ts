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
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { RetirementDateDto } from './dto/retirement-date.dto';
import { RetirementPreviewResponseDto } from './dto/retirement-preview.response.dto';
import { parseDateOnly } from './kst-date';
import { RetirementService } from './retirement.service';

const NOT_FOUND_MESSAGE = '직원을 찾을 수 없습니다';
const MAX_ID = 2_147_483_647;

/**
 * 직원 퇴직 처리 (WHALEERP-584). 관리자 웹만 쓴다. 관리 범위 밖 점포의 직원은 없는 직원과 같은 404 다 —
 * 403 을 주면 다른 BP 에 그 ID 의 직원이 있다는 것이 드러난다.
 */
@ApiBearerAuth()
@ApiNotFoundResponse({ description: '없는 직원이거나 관리 범위 밖' })
@ApiBadRequestResponse({
  description: '퇴직일 형식 오류 · 3개월보다 오래됨 · 입사일보다 앞섬',
})
@ApiConflictResponse({
  description:
    '가입 전 · 이미 퇴직 · 이미 퇴직 예정(처리) / 퇴직 예정이 아님 · 퇴직일 당일 이후 · 같은 날짜(취소 · 변경)',
})
@UserTypes('admin')
@Controller('staff-members')
export class RetirementController {
  constructor(
    private readonly retirement: RetirementService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 퇴직이 확정될 때 정리될 근무스케줄 · 개인 TO-DO · 대기 계약. 확인창에 보여 준다. */
  @Get(':id/retirement-preview')
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: RetirementDateDto,
  ): Promise<RetirementPreviewResponseDto> {
    const id = await this.staffInScope(user, rawId);
    return this.retirement.preview(id, this.dateOf(query));
  }

  /**
   * 퇴직 처리. 퇴직일만 저장하고 재직으로 둔다(퇴직 예정). 계약은 바꾸지 않는다. 퇴직일 다음 날 0시 배치가
   * 퇴직으로 바꾸며 정리하고, 지난 날짜면 지금 바로 정리한다. 가입 전 · 이미 퇴직 · 이미 퇴직 예정이면 409.
   */
  @Post(':id/retirement')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retire(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: RetirementDateDto,
  ): Promise<void> {
    const id = await this.staffInScope(user, rawId);
    await this.retirement.retire(user.id, id, this.dateOf(body));
  }

  /** 퇴직일 변경. 퇴직 예정이고 퇴직일 전날까지만 된다(그 밖은 409). */
  @Put(':id/retirement')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeDate(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: RetirementDateDto,
  ): Promise<void> {
    const id = await this.staffInScope(user, rawId);
    await this.retirement.changeDate(user.id, id, this.dateOf(body));
  }

  /** 퇴직 취소. 퇴직 예정이고 퇴직일 전날까지만 된다(그 밖은 409). */
  @Delete(':id/retirement')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<void> {
    const id = await this.staffInScope(user, rawId);
    await this.retirement.cancel(user.id, id);
  }

  /**
   * 경로의 ID 를 읽고 관리 범위를 확인한다. 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면
   * PostgreSQL 이 오류를 내 404 가 500 이 된다.
   */
  private async staffInScope(user: AuthUser, rawId: string): Promise<number> {
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (!(await this.scope.canManageStaffMember(user.id, id)))
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    return id;
  }

  /** DTO 의 `IsDateOnly` 가 이미 있는 날짜인지 확인했다. */
  private dateOf({ retiredDate }: RetirementDateDto): Date {
    return parseDateOnly(retiredDate) as Date;
  }
}
