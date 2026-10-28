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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import type { Response } from 'express';
import { MenuPermission } from '../auth/menu-permission.guard';
import { signedInUserTracker } from '../auth/throttle';
import { AdminProfileEmailAvailabilityQueryDto } from '../auth/dto/admin-profile-email-availability-query.dto';
import { AdminProfileEmailAvailabilityResponseDto } from '../auth/dto/admin-profile-email-availability.response.dto';
import { parseRouteId } from '../common/route-id';
import { PageDto } from '../platform-admins/dto/list-platform-admins.dto';
import {
  LoginIdAvailabilityQueryDto,
  LoginIdAvailabilityResponseDto,
} from '../platform-admins/dto/login-id-availability.dto';
import { ExcelScheduledResponseDto } from '../excel-exports/dto/excel-export.response.dto';
import { ExcelExportsService } from '../excel-exports/excel-exports.service';
import {
  excelResponse,
  XLSX_CONTENT_TYPE,
} from '../excel-exports/excel-response';
import { BpMasterExcelSource } from './bp-master-excel.source';
import { BpMastersService } from './bp-masters.service';
import { ChangeBpMasterStatusDto } from './dto/bp-master-status.dto';
import {
  BpMasterBusinessVerificationResponseDto,
  BpMasterDetailResponseDto,
  BpMasterHistoryListResponseDto,
  BpMasterListResponseDto,
  CreateBpMasterResponseDto,
  ResetBpMasterPasswordResponseDto,
} from './dto/bp-master.response.dto';
import { BpMasterFilterDto, ListBpMastersDto } from './dto/list-bp-masters.dto';
import {
  CreateBpMasterDto,
  UpdateBpMasterDto,
  VerifyBpMasterBusinessDto,
} from './dto/save-bp-master.dto';

const NOT_FOUND_DESCRIPTION = '없거나 지운 BP · 플랫폼 BP';
const WITHDRAWN_DESCRIPTION = '탈퇴한 BP';

/**
 * BP 마스터 계정 관리(메뉴 MN000203). 메뉴는 경로 첫 단계 `/bp-masters` 로 정해지고, 그 위에 플랫폼 계정(플랫폼 BP 의
 * PM · PA)이어야 한다(platformOnly). 대상 BP 는 경로의 id 다 — X-Bp-Code-Id(ERP 화면의 탭 BP)는 쓰지 않는다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '메뉴 권한 없음 · 플랫폼 계정이 아님' })
@UserTypes('admin')
@Controller('bp-masters')
export class BpMastersController {
  constructor(
    private readonly bpMasters: BpMastersService,
    private readonly excelExports: ExcelExportsService,
    private readonly excelSource: BpMasterExcelSource,
  ) {}

  /** 목록. 고객 BP, 등록 일시 최신순. */
  @Get()
  @MenuPermission('read', { platformOnly: true })
  list(@Query() query: ListBpMastersDto): Promise<BpMasterListResponseDto> {
    return this.bpMasters.list(query);
  }

  /**
   * 엑셀(xlsx). 목록과 같은 조건으로 전부, 연락처 · 대표자 연락처는 가운데 자리를 가린다. 공통 엑셀 규칙을 따른다 —
   * 1만 건 미만은 바로 파일(200), 이상은 예약 생성(202, 등록한 이메일로 링크). 같은 사람이 생성 중이면 409, 1분에
   * 한 번(429). `:id` 보다 먼저 둔다.
   */
  @Get('excel')
  @MenuPermission('read', { platformOnly: true })
  @ApiProduces(XLSX_CONTENT_TYPE, 'application/json')
  @ApiOkResponse({
    description: 'BP목록_YYYYMMDD.xlsx',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiAcceptedResponse({
    description: '1만 건 이상 — 예약 생성(메일로 링크)',
    type: ExcelScheduledResponseDto,
  })
  @ApiBadRequestResponse({
    description: '검색 조건 형식 · 1만 건 이상인데 등록한 이메일이 없음',
  })
  @ApiConflictResponse({ description: '같은 화면의 엑셀을 만드는 중' })
  @ApiTooManyRequestsResponse({ description: '1분 안에 다시 받음' })
  @ApiServiceUnavailableResponse({
    description: '1만 건 이상인데 메일 · 저장소 설정이 없음',
  })
  async excel(
    @CurrentUser() user: AuthUser,
    @Query() query: BpMasterFilterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | ExcelScheduledResponseDto> {
    const result = await this.excelExports.request(
      this.excelSource,
      { adminAccountId: user.id, bp: null },
      query,
    );
    return excelResponse(result, res);
  }

  /** 아이디 중복 확인. 등록 권한이 필요하다. `:id` 보다 먼저 둔다. */
  @Get('login-id-availability')
  @MenuPermission('create', { platformOnly: true })
  @ApiBadRequestResponse({ description: '아이디 형식' })
  async loginIdAvailability(
    @Query() query: LoginIdAvailabilityQueryDto,
  ): Promise<LoginIdAvailabilityResponseDto> {
    return {
      available: await this.bpMasters.isLoginIdAvailable(query.loginId),
    };
  }

  /** 이메일 중복 확인. 아이디 확인과 같은 등록 권한이다. `:id` 보다 먼저 둔다. */
  @Get('email-availability')
  @MenuPermission('create', { platformOnly: true })
  @ApiBadRequestResponse({ description: '이메일 형식' })
  async emailAvailability(
    @Query() query: AdminProfileEmailAvailabilityQueryDto,
  ): Promise<AdminProfileEmailAvailabilityResponseDto> {
    return { available: await this.bpMasters.isEmailAvailable(query.email) };
  }

  /**
   * 사업자 진위확인 — 검사만 하고 10분짜리 토큰을 준다. 등록 · 수정 저장에 실어야 반영된다.
   * 국세청 키 · 하루 할당량을 모든 BP 가 함께 쓰므로 IP · 계정마다 시간당 10건(점포 · 가입과 같다).
   */
  @Post('business-verifications')
  @MenuPermission(['create', 'update'], { platformOnly: true })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    ip: { limit: 10, ttl: 3_600_000 },
    account: { limit: 10, ttl: 3_600_000, getTracker: signedInUserTracker },
  })
  @ApiBadRequestResponse({ description: '입력 형식' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: `사업자등록번호 중복 · ${WITHDRAWN_DESCRIPTION}`,
  })
  @ApiUnprocessableEntityResponse({ description: '국세청 정보와 다름' })
  @ApiTooManyRequestsResponse({ description: '시간당 한도(10건)' })
  @ApiServiceUnavailableResponse({
    description: '사업자 진위확인 연동이 없거나 실패함',
  })
  verifyBusiness(
    @CurrentUser() user: AuthUser,
    @Body() body: VerifyBpMasterBusinessDto,
  ): Promise<BpMasterBusinessVerificationResponseDto> {
    return this.bpMasters.verifyBusiness(user.id, body);
  }

  /** 상세. 탈퇴한 BP 도 보인다(개인정보는 null). */
  @Get(':id')
  @MenuPermission('read', { platformOnly: true })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  detail(@Param('id') rawId: string): Promise<BpMasterDetailResponseDto> {
    return this.bpMasters.detail(idOf(rawId));
  }

  /** 변경 이력 — BP 와 BP 마스터 계정의 이력을 합쳐 최신순. 탈퇴한 BP 는 409(이력에 탈퇴 전 개인정보가 남아 있다). */
  @Get(':id/histories')
  @MenuPermission('read', { platformOnly: true })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '탈퇴한 BP — 변경 이력을 볼 수 없다' })
  histories(
    @Param('id') rawId: string,
    @Query() query: PageDto,
  ): Promise<BpMasterHistoryListResponseDto> {
    return this.bpMasters.histories(idOf(rawId), query);
  }

  /** 등록. BP 와 BP 마스터 계정을 함께 만들고 1시간짜리 초기 비밀번호를 메일로만 보낸다. */
  @Post()
  @MenuPermission('create', { platformOnly: true })
  @ApiBadRequestResponse({ description: '입력 형식 · 인증 토큰 만료' })
  @ApiConflictResponse({ description: '아이디 · 이메일 · 사업자등록번호 중복' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateBpMasterDto,
  ): Promise<CreateBpMasterResponseDto> {
    return this.bpMasters.create(user.id, body);
  }

  /** 수정. 마지막 저장이 남는다(동시 수정 확인 없음). */
  @Put(':id')
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({ description: '입력 형식 · 인증 토큰 만료' })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: `이메일 · 사업자등록번호 중복 · ${WITHDRAWN_DESCRIPTION}`,
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdateBpMasterDto,
  ): Promise<void> {
    await this.bpMasters.update(user.id, idOf(rawId), body);
  }

  /** 상태 변경(사용 ↔ 미사용). 미사용이면 그 BP 의 관리자 계정 전부가 함께 미사용이 된다. */
  @Post(':id/status')
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: `${WITHDRAWN_DESCRIPTION} · 그 사이 다른 관리자가 상태를 바꿈`,
  })
  async changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: ChangeBpMasterStatusDto,
  ): Promise<void> {
    await this.bpMasters.changeStatus(user.id, idOf(rawId), body.status);
  }

  /** 비밀번호 초기화. 새 1시간짜리 비밀번호를 BP 마스터 이메일로만 보낸다. 수정 권한이 필요하다. */
  @Post(':id/password-reset')
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: `${WITHDRAWN_DESCRIPTION} · 이메일 없음 · 그 사이 이메일이 바뀜`,
  })
  @ApiServiceUnavailableResponse({
    description:
      '메일 설정(MAIL_* · ADMIN_WEB_URL)이 없는 환경 — 아무것도 바꾸지 않는다',
  })
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<ResetBpMasterPasswordResponseDto> {
    return this.bpMasters.resetPassword(user.id, idOf(rawId));
  }

  /** 삭제(논리 삭제) — 오등록만. 상세의 deletion 조건을 서버에서 다시 본다. */
  @Delete(':id')
  @MenuPermission('delete', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description: '탈퇴 · 로그인 기록 · 하위 관리자 · 점포가 있어 지울 수 없음',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.bpMasters.remove(user.id, idOf(rawId));
  }
}

/** 경로의 id 는 문자열이다. 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException('BP를 찾을 수 없습니다');
  return id;
}
