import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { CreatePayslipDto, PayslipMonthDto } from './dto/payslip-draft.dto';
import {
  PayslipBulkCreateResponseDto,
  PayslipCandidatesResponseDto,
  PayslipCreatedDto,
} from './dto/payslip-draft.response.dto';
import { PayslipListQueryDto } from './dto/payslip-list.query.dto';
import {
  PayslipDetailResponseDto,
  PayslipListResponseDto,
} from './dto/payslip.response.dto';
import { PayslipDraftService } from './payslip-draft.service';
import { PayslipListService } from './payslip-list.service';
import { PAYSLIP_MENU, PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';

/**
 * 급여명세서 관리 목록 · 상세 (WHALEERP-330), 초안 작성 (WHALEERP-226). 관리자 웹만 쓰고 급여명세서 관리 조회
 * 권한이 있어야 한다 — 작성 대상 · 초안 · 일괄 작성은 등록 권한. 직원 앱 토큰 · 권한 없는 관리자는 403. 근무지는
 * 관리 범위 전체다(따로 받지 않는다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '급여명세서 관리 조회 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@MenuPermission(PAYSLIP_MENU, 'read')
@Controller('payslips')
export class PayslipsController {
  constructor(
    private readonly payslips: PayslipListService,
    private readonly drafts: PayslipDraftService,
  ) {}

  @Get()
  @ApiBadRequestResponse({ description: '쿼리 형식 오류(month 누락 포함)' })
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: PayslipListQueryDto,
  ): Promise<PayslipListResponseDto> {
    const result = await this.payslips.list(user.id, query);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /**
   * 작성 대상 — 그 달(1일 ~ 말일) 관리 범위 직원의 유효 계약 · 이미 있는 명세서 · 출퇴근 기록 유무. `:id` 보다 먼저
   * 선언해야 한다.
   */
  @Get('candidates')
  @MenuPermission(PAYSLIP_MENU, 'create')
  @ApiBadRequestResponse({ description: '쿼리 형식 오류(month 누락 포함)' })
  async candidates(
    @CurrentUser() user: AuthUser,
    @Query() query: PayslipMonthDto,
  ): Promise<PayslipCandidatesResponseDto> {
    const result = await this.drafts.candidates(user.id, query.month);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /** 직원 한 명의 초안. */
  @Post()
  @MenuPermission(PAYSLIP_MENU, 'create')
  @ApiBadRequestResponse({ description: '본문 형식 오류' })
  @ApiNotFoundResponse({
    description:
      '없는 직원 · 관리 범위 밖 · 가려지는 직원(본사 제공 동의 없음)',
  })
  @ApiConflictResponse({
    description:
      'PAYSLIP_EXISTS — 이 직원의 이 달 명세서가 이미 있음(본문 payslipId)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'NO_VALID_CONTRACT — 급여 기간에 유효한 근로계약 없음',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePayslipDto,
  ): Promise<PayslipCreatedDto> {
    const result = await this.drafts.create(
      user.id,
      dto.staffMemberId,
      dto.month,
    );
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /** 관리 범위 작성 대상 모두의 초안. 이미 있음 · 계약 없음은 건너뛰고 skipped 에 담는다. */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @MenuPermission(PAYSLIP_MENU, 'create')
  @ApiBadRequestResponse({ description: '본문 형식 오류' })
  async bulkCreate(
    @CurrentUser() user: AuthUser,
    @Body() dto: PayslipMonthDto,
  ): Promise<PayslipBulkCreateResponseDto> {
    const result = await this.drafts.bulkCreate(user.id, dto.month);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /** 없는 명세서 · 관리 범위 밖 · 가려지는 명세서(본사 제공 동의 없는 가맹 점포 직원)는 모두 같은 404 다. */
  @Get(':id')
  @ApiNotFoundResponse({
    description: '없는 명세서 · 관리 범위 밖 · 가려지는 명세서 · ID 형식 오류',
  })
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PayslipDetailResponseDto> {
    const id = parseRouteId(rawId);
    const item = id && (await this.payslips.findOne(user.id, id));
    if (!item) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    return item;
  }
}
