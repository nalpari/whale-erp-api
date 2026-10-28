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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiBadGatewayResponse,
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
import { PayslipStatusChangeDto, SavePayslipDto } from './dto/payslip-edit.dto';
import {
  PayslipAdditionalItemsResponseDto,
  PayslipPreviousResponseDto,
} from './dto/payslip-edit.response.dto';
import {
  PayslipListQueryDto,
  PayslipSummaryQueryDto,
} from './dto/payslip-list.query.dto';
import { SendPayslipsDto } from './dto/payslip-send.dto';
import { PayslipSendResultDto } from './dto/payslip-send.response.dto';
import {
  PayslipDetailResponseDto,
  PayslipListResponseDto,
  PayslipSummaryResponseDto,
} from './dto/payslip.response.dto';
import { PayslipDraftService } from './payslip-draft.service';
import { PayslipEditService } from './payslip-edit.service';
import { PayslipListService } from './payslip-list.service';
import { PayslipSendService } from './payslip-send.service';
import { PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';

const NOT_FOUND_DESCRIPTION =
  '없는 명세서 · 관리 범위 밖 · 가려지는 명세서 · ID 형식 오류';
const SEND_CONFLICT =
  'PAYSLIP_STATUS_CONFLICT — 보낼 수 있는 상태가 아님 · PAYSLIP_STALE — 그사이 누가 고쳤거나 보내는 중';
const SEND_UNAVAILABLE =
  'MAIL_NOT_CONFIGURED · APP_URL_NOT_CONFIGURED — 메일 설정 · 직원 앱 주소 없음';

/**
 * 급여명세서 관리 목록 · 상세 (WHALEERP-330), 점포 · 월 요약 (WHALEERP-621), 초안 작성 (WHALEERP-226), 임시저장 · 지난 명세서 불러오기 (WHALEERP-228),
 * 확정 · 확정 취소 (WHALEERP-230), 발송 · 재발송 (WHALEERP-231). 관리자 웹만 쓴다. 권한은 메서드마다 경로 /payslips 의
 * 메뉴(MN000009)로 판정한다 — 목록 · 상세 · 요약은 조회, 작성 대상 · 초안 · 일괄 작성은 등록, 그 밖(임시저장 · 확정 · 확정 취소 ·
 * 발송 · 재발송 · 불러오기 · 추가 공제 항목)은 수정 권한. 직원 앱 토큰 · 권한 없는 관리자는 403.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '급여명세서 관리의 해당 권한(조회 · 등록 · 수정) 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@Controller('payslips')
export class PayslipsController {
  constructor(
    private readonly payslips: PayslipListService,
    private readonly drafts: PayslipDraftService,
    private readonly edits: PayslipEditService,
    private readonly sends: PayslipSendService,
  ) {}

  @Get()
  @MenuPermission('read')
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
   * 점포 하나 · 급여 월 하나의 요약(로그인 후 홈 점포 하나 화면 직원 급여 카드, WHALEERP-621). `:id` 보다 먼저 선언해야
   * 한다.
   */
  @Get('summary')
  @MenuPermission('read')
  @ApiBadRequestResponse({
    description: '쿼리 형식 오류(month · storeId 누락 포함)',
  })
  async summary(
    @CurrentUser() user: AuthUser,
    @Query() query: PayslipSummaryQueryDto,
  ): Promise<PayslipSummaryResponseDto> {
    const result = await this.payslips.summary(user.id, query);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /**
   * 작성 대상 — 그 달(1일 ~ 말일) 관리 범위 직원의 유효 계약 · 이미 있는 명세서 · 출퇴근 기록 유무. `:id` 보다 먼저
   * 선언해야 한다.
   */
  @Get('candidates')
  @MenuPermission('create')
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
  @MenuPermission('create')
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
  @MenuPermission('create')
  @ApiBadRequestResponse({ description: '본문 형식 오류' })
  async bulkCreate(
    @CurrentUser() user: AuthUser,
    @Body() dto: PayslipMonthDto,
  ): Promise<PayslipBulkCreateResponseDto> {
    const result = await this.drafts.bulkCreate(user.id, dto.month);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /**
   * 그 달 확정 명세서 일괄 발송(목록 「확정 N건 발송」). 일부가 실패해도 보낸 것은 그대로이고 실패 대상을 이유와 함께 돌려준다.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiBadRequestResponse({ description: '본문 형식 오류' })
  async sendMany(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendPayslipsDto,
  ): Promise<PayslipSendResultDto> {
    const result = await this.sends.sendMany(user.id, dto);
    if (!result) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return result;
  }

  /** 「항목 추가」로 붙일 수 있는 추가 공제(사용 중인 급여 항목). `:id` 보다 먼저 선언해야 한다. */
  @Get('additional-items')
  @MenuPermission('update')
  additionalItems(): Promise<PayslipAdditionalItemsResponseDto> {
    return this.edits.additionalItems();
  }

  /** 없는 명세서 · 관리 범위 밖 · 가려지는 명세서(본사 제공 동의 없는 가맹 점포 직원)는 모두 같은 404 다. */
  @Get(':id')
  @MenuPermission('read')
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

  /** 같은 직원의 지난 명세서 값(공제 · 관리자가 넣는 지급). 화면이 칸을 채울 뿐 저장하지 않는다. */
  @Get(':id/previous-values')
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async previousValues(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PayslipPreviousResponseDto> {
    return this.edits.previousValues(user.id, routeId(rawId));
  }

  /** 임시저장 — 금액 · 가산 · 3.3% · 추가 공제 붙이기 · 떼기. 상태는 그대로이고 상세를 돌려준다. */
  @Put(':id')
  @MenuPermission('update')
  @ApiBadRequestResponse({
    description:
      '본문 형식 오류 · 정직원 3.3% · 같은 항목 두 번 · 붙일 수 없는 항목 · 합계 초과',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      'PAYSLIP_STATUS_CONFLICT — 작성 중 · 검토 중이 아님 · PAYSLIP_STALE — 그사이 누가 고침',
  })
  async save(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: SavePayslipDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(await this.edits.save(user.id, routeId(rawId), dto));
  }

  /** 출퇴근으로 다시 계산 — 기본급 · 주휴수당 · 연장수당을 지금 출퇴근 기록으로 다시 계산하고 고친 값은 버린다(WHALEERP-227). */
  @Post(':id/recalculate')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      'PAYSLIP_STATUS_CONFLICT — 작성 중 · 검토 중이 아님 · PAYSLIP_STALE — 그사이 누가 고침',
  })
  async recalculate(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(await this.edits.recalculate(user.id, routeId(rawId), dto));
  }

  /** 확정 — 보이는 공제가 모두 있어야 한다. 검토 사유는 확인한 것으로 남는다. */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      'PAYSLIP_STATUS_CONFLICT — 작성 중 · 검토 중이 아님 · PAYSLIP_STALE — 그사이 누가 고침',
  })
  @ApiUnprocessableEntityResponse({
    description: 'DEDUCTION_MISSING — 비어 있는 공제(본문 items)',
  })
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(await this.edits.confirm(user.id, routeId(rawId), dto));
  }

  /** 확정 취소 — 확정 · 발송 완료에서 검토 중으로. */
  @Post(':id/cancel-confirmation')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      'PAYSLIP_STATUS_CONFLICT — 확정 · 발송 완료가 아님 · PAYSLIP_STALE — 그사이 누가 고침',
  })
  async cancelConfirmation(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(
      await this.edits.cancelConfirmation(user.id, routeId(rawId), dto),
    );
  }
  /** 발송 — 확정만. 직원 앱 계정 이메일로 보내고(앱 푸시는 아직 없음) 발송 완료로 바꾼다. */
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: SEND_CONFLICT })
  @ApiUnprocessableEntityResponse({
    description: 'NO_EMAIL — 직원 앱 계정 없음(가입 전 · 탈퇴)',
  })
  @ApiServiceUnavailableResponse({ description: SEND_UNAVAILABLE })
  @ApiBadGatewayResponse({
    description: 'SEND_FAILED — 메일 발송 실패(확정 그대로, 발송 이력에 실패)',
  })
  async send(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(await this.sends.send(user.id, routeId(rawId), dto));
  }

  /** 재발송 — 발송 완료만(관리자 확인을 거친 뒤 부른다). 재발송 템플릿으로 보낸다. */
  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @MenuPermission('update')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: SEND_CONFLICT })
  @ApiUnprocessableEntityResponse({
    description: 'NO_EMAIL — 직원 앱 계정 없음(가입 전 · 탈퇴)',
  })
  @ApiServiceUnavailableResponse({ description: SEND_UNAVAILABLE })
  @ApiBadGatewayResponse({ description: 'SEND_FAILED — 메일 발송 실패' })
  async resend(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto> {
    return found(await this.sends.resend(user.id, routeId(rawId), dto));
  }
}

/** 경로의 id. 형식이 틀리면 서비스를 부르지 않고 404(상세와 같다). */
function routeId(rawId: string): number {
  const id = parseRouteId(rawId);
  if (!id) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
  return id;
}

/** 고친 뒤 다시 읽은 상세. 그사이 지워졌거나 범위 밖이 됐으면 404. */
function found(
  item: PayslipDetailResponseDto | null,
): PayslipDetailResponseDto {
  if (!item) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
  return item;
}
