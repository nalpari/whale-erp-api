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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { signedInUserTracker } from '../auth/throttle';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import type { Response } from 'express';
import { parseRouteId } from '../common/route-id';
import { ExcelScheduledResponseDto } from '../excel-exports/dto/excel-export.response.dto';
import { ExcelExportsService } from '../excel-exports/excel-exports.service';
import {
  excelResponse,
  XLSX_CONTENT_TYPE,
} from '../excel-exports/excel-response';
import { AttachmentsInterceptor } from '../storage/upload-check';
import { ListStoreOptionsQueryDto } from './dto/list-store-options-query.dto';
import {
  ListStoresQueryDto,
  StoreExcelQueryDto,
  StoreHistoryPageDto,
} from './dto/list-stores-query.dto';
import {
  CreateStoreDto,
  UpdateStoreDto,
  VerifyStoreBusinessDto,
} from './dto/save-store.dto';
import { StoreOptionListResponseDto } from './dto/store-option.response.dto';
import {
  CreateStoreResponseDto,
  StoreBusinessVerificationResponseDto,
  StoreDetailResponseDto,
  StoreHistoryListResponseDto,
  StoreImageResponseDto,
  StoreListResponseDto,
  StoreTransitionCheckResponseDto,
} from './dto/store.response.dto';
import { StoreExcelSource } from './store-excel.source';
import {
  STORE_IMAGE_MAX_BYTES,
  StoreManagementService,
  type StoreImageUpload,
} from './store-management.service';
import { StoresService } from './stores.service';

/** 가드가 정한 대상 BP 의 404 — 플랫폼 계정이 보낸 X-Bp-Code-Id 가 쓸 수 없는 BP 다. */
const BP_NOT_FOUND_DESCRIPTION =
  '플랫폼 계정의 X-Bp-Code-Id 가 없는 · 지운 · 플랫폼 BP 이거나 형식이 틀림(가드)';
const NOT_FOUND_DESCRIPTION = `없거나 지운 점포 · 볼 수 없는 점포(대상 BP 밖 포함) · ${BP_NOT_FOUND_DESCRIPTION}`;
/** 플랫폼 계정이 BP 를 고르지 않음 — BP 권한 그룹과 같은 400 이다. */
const BP_MISSING_DESCRIPTION = '플랫폼 계정의 X-Bp-Code-Id 누락';

/**
 * 점포. 관리자 웹 「점포 정보 관리」(`/stores`, 현재 MN000002)는 경로마다 메뉴 권한(조회 · 등록 · 수정 · 삭제)을 가드
 * (@MenuPermission)가 판정하고, 업무 규칙(범위 · 상태 · BP 사용 여부 · 가맹 역할 등록 금지)은 StoreManagementService 가 본다.
 * 다루는 점포의 BP 는 가드가 X-Bp-Code-Id 로 정한다(`@TargetBp()`) — BP · 가맹 계정은 소속 BP, 플랫폼 계정은 헤더로
 * 고객 BP 를 보내야 한다(없으면 서비스가 400, BP 권한 그룹과 같다).
 * 근로계약서 근무지 선택지(`/stores/options`)는 메뉴 권한 없이 업무 범위로만 거른다 — 근로계약 화면이 쓴다. 헤더도 보지 않는다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 메뉴 권한 없음 · BP · 가맹 계정의 다른 BP · 형식이 틀린 헤더 · 가맹 계정의 등록',
})
// 본문 · 쿼리를 받는 경로는 자기 400(형식)과 함께 다시 적는다 — 메서드의 설명이 클래스의 것을 덮는다.
@ApiBadRequestResponse({ description: BP_MISSING_DESCRIPTION })
@UserTypes('admin')
@Controller('stores')
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly management: StoreManagementService,
    private readonly excelExports: ExcelExportsService,
    private readonly excelSource: StoreExcelSource,
  ) {}

  /** 근무지 선택지. 업무 범위 안에서 지우지 않았고 폐점이 아닌 점포, 이름순. `:id` 보다 먼저 둔다. */
  @Get('options')
  @ApiOkResponse({ type: StoreOptionListResponseDto })
  // 메뉴 권한을 보지 않는 경로라 클래스의 403 설명(메뉴 권한 · 가맹 등록)을 덮어쓴다.
  @ApiForbiddenResponse({
    description: '직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
  })
  @ApiBadRequestResponse({ description: '검색 조건 형식' })
  options(
    @Query() query: ListStoreOptionsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StoreOptionListResponseDto> {
    return this.stores.options(user.id, query);
  }

  /** 점포 정보 관리 목록. 등록일 최신순, 기본은 미운영 · 운영. */
  @Get()
  @MenuPermission('read')
  @ApiBadRequestResponse({
    description: `검색 조건 형식 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  list(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListStoresQueryDto,
  ): Promise<StoreListResponseDto> {
    return this.management.list(user.id, bp, query);
  }

  /**
   * 엑셀(xlsx). 목록과 같은 검색 조건으로 전부 담고, 대표자 연락처만 가운데 자리를 가린다. 공통 엑셀 규칙을 따른다 —
   * 1만 건 미만은 바로 파일(200), 이상은 예약 생성(202, 다 만들어지면 등록한 이메일로 링크). 같은 사람 · 같은 화면은 생성
   * 중이면 409, 1분에 한 번(429). `:id` 보다 먼저 둔다.
   */
  @Get('excel')
  @MenuPermission('read')
  @ApiProduces(XLSX_CONTENT_TYPE, 'application/json')
  @ApiOkResponse({
    description: '점포목록_YYYYMMDD.xlsx',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiAcceptedResponse({
    description: '1만 건 이상 — 예약 생성(메일로 링크)',
    type: ExcelScheduledResponseDto,
  })
  @ApiBadRequestResponse({
    description: `검색 조건 형식 · 1만 건 이상인데 등록한 이메일이 없음 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '같은 화면의 엑셀을 만드는 중' })
  @ApiTooManyRequestsResponse({ description: '1분 안에 다시 받음' })
  @ApiServiceUnavailableResponse({
    description: '1만 건 이상인데 메일 · 저장소 설정이 없음',
  })
  async excel(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: StoreExcelQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | ExcelScheduledResponseDto> {
    const result = await this.excelExports.request(
      this.excelSource,
      { adminAccountId: user.id, bp },
      query,
    );
    return excelResponse(result, res);
  }

  /**
   * 저장 전 사업자 인증 확인. 등록 또는 수정 권한이 있으면 된다. 저장할 때 서버가 다시 확인하므로 이 결과는
   * 화면 안내용이다.
   */
  // IP · 계정마다 시간당 10건 — 회원가입의 진위확인과 같은 기준이다. 국세청을 실제로 부르는 횟수는 서비스가
  // 등록 · 수정과 함께 관리자별로 따로 센다(StoreManagementService.countNtsCall). 국세청 키 · 하루 할당량을 모든 BP 가
  // 함께 쓰므로, 한 관리자가 반복해 부르면 그날 모든 BP 의 가입 · 점포 인증이 503 이 된다. TRUST_PROXY 가 관리자
  // 웹 서버를 믿지 않으면(또는 한 사무실 NAT 뒤면) 그 관리자들이 IP 한 칸을 나눠 쓴다.
  @Post('business-verifications')
  @MenuPermission(['create', 'update'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    ip: { limit: 10, ttl: 3_600_000 },
    account: { limit: 10, ttl: 3_600_000, getTracker: signedInUserTracker },
  })
  @ApiTooManyRequestsResponse({ description: 'IP · 계정의 시간당 한도(10건)' })
  @ApiBadRequestResponse({
    description: `입력 형식 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiServiceUnavailableResponse({
    description: '사업자 진위확인 연동이 없거나 실패함',
  })
  verifyBusiness(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: VerifyStoreBusinessDto,
  ): Promise<StoreBusinessVerificationResponseDto> {
    return this.management.verifyBusiness(user.id, bp, body);
  }

  @Get(':id')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  detail(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<StoreDetailResponseDto> {
    return this.management.detail(user.id, bp, idOf(rawId));
  }

  /** 변경 이력. 보존 기한(5년) 안의 것, 최신순. */
  @Get(':id/histories')
  @MenuPermission('read')
  @ApiBadRequestResponse({
    description: `쪽 형식 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  histories(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Query() query: StoreHistoryPageDto,
  ): Promise<StoreHistoryListResponseDto> {
    return this.management.histories(user.id, bp, idOf(rawId), query);
  }

  /** 운영 · 폐점 · 삭제를 지금 할 수 있는가. 수정 화면이 폐점을 고를 때 다시 묻는다. */
  @Get(':id/transition-check')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  transitionCheck(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<StoreTransitionCheckResponseDto> {
    return this.management.transitionCheck(user.id, bp, idOf(rawId));
  }

  /** 등록. 늘 미운영으로 만들고 점포코드를 채번한다. 가맹 계정은 403. */
  @Post()
  @MenuPermission('create')
  @ApiBadRequestResponse({
    description: `입력 형식 · 위도 · 경도 중 하나만 있음 · ${BP_MISSING_DESCRIPTION} · 본문 bpCodeId 가 대상 BP 와 다름 · 대상 BP 를 그사이 지움 · 국세청 정보와 다름`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '소속 BP 미사용 · 사업자등록번호 중복 · 점포코드 채번이 겹침 · 점포코드(6자리)를 다 씀',
  })
  @ApiServiceUnavailableResponse({
    description:
      '사업자 인증을 보냈는데 진위확인 연동이 없거나 실패함 · 등록이 몰려 시간을 넘김',
  })
  @ApiTooManyRequestsResponse({
    description:
      '사업자 인증을 보냈는데 관리자의 국세청 호출이 시간당 10번을 넘음',
  })
  create(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: CreateStoreDto,
  ): Promise<CreateStoreResponseDto> {
    return this.management.create(user.id, bp, body);
  }

  /** 수정 · 상태 전환. 상세에서 받은 updatedAt 을 함께 보낸다 — 그 사이 다른 사람이 고쳤으면 409. */
  @Put(':id')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({
    description: `입력 형식 · 위도 · 경도 중 하나만 있음 · 바꿀 수 없는 상태 전환 · 운영으로 바꿀 때 운영 조건(인증 · 좌표) 미충족 · 운영 중인 점포의 좌표 삭제 · 국세청 정보와 다름 · 재인증 번호 불일치 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '동시 수정 · 폐점한 점포 · 소속 BP 미사용 · 진행 중인 근로계약(폐점) · 사업자등록번호 중복',
  })
  @ApiServiceUnavailableResponse({
    description: '사업자 인증을 보냈는데 진위확인 연동이 없거나 실패함',
  })
  @ApiTooManyRequestsResponse({
    description:
      '사업자 인증을 보냈는데 관리자의 국세청 호출이 시간당 10번을 넘음',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Body() body: UpdateStoreDto,
  ): Promise<void> {
    await this.management.update(user.id, bp, idOf(rawId), body);
  }

  /** 삭제(논리 삭제). 미운영이면서 진행 중인 근로계약이 없을 때만. */
  @Delete(':id')
  @MenuPermission('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '미운영이 아님 · 진행 중인 근로계약 · 소속 BP 미사용 · 그 사이 상태가 바뀜',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.management.remove(user.id, bp, idOf(rawId));
  }

  /**
   * 대표 이미지 올리기 · 바꾸기(점포당 1장). multipart 의 `file` 한 개, JPG · PNG 5MB 이하 — 종류는 확장자가
   * 아니라 내용으로 본다. 등록 화면은 점포를 등록한 뒤 이 경로로 올린다. 수정 권한이 있어야 한다.
   *
   * 가드는 인터셉터보다 먼저 돌므로, 권한 없는 관리자의 요청은 AttachmentsInterceptor 가 multipart 본문
   * (최대 5MB)을 받기 전에 403 이다.
   */
  @Put(':id/image')
  @MenuPermission('update')
  @UseInterceptors(AttachmentsInterceptor('file', 1, STORE_IMAGE_MAX_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: StoreImageResponseDto })
  @ApiBadRequestResponse({
    description: `파일 없음 · JPG · PNG 가 아님 · 5MB 초과 · 파일 2개 이상 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '폐점한 점포 · 소속 BP 미사용' })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않았거나 올리기에 실패함',
  })
  putImage(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @UploadedFiles() files: StoreImageUpload[] | undefined,
  ): Promise<StoreImageResponseDto> {
    return this.management.putImage(user.id, bp, idOf(rawId), files?.[0]);
  }

  /** 대표 이미지 지우기. 이미지가 없어도 204. 수정 권한이 있어야 한다. */
  @Delete(':id/image')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '폐점한 점포 · 소속 BP 미사용' })
  async removeImage(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.management.removeImage(user.id, bp, idOf(rawId));
  }
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException('점포를 찾을 수 없습니다');
  return id;
}
