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
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiProduces,
  type ApiBodyOptions,
  type ApiResponseOptions,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { FacilityDocumentKind } from '@prisma/client';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { XLSX_CONTENT_TYPE } from '../excel-exports/excel-response';
import { contentDisposition } from '../storage/storage.service';
import { AttachmentsInterceptor } from '../storage/upload-check';
import {
  FacilityManagerOptionsQueryDto,
  FacilityStoreOptionsQueryDto,
  ListFacilitiesQueryDto,
} from './dto/list-facilities-query.dto';
import { CreateFacilityDto, UpdateFacilityDto } from './dto/save-facility.dto';
import {
  BulkCreateResponseDto,
  BulkPreviewResponseDto,
} from '../common/bulk-upload.response.dto';
import {
  CreateFacilityResponseDto,
  FacilityDetailResponseDto,
  FacilityDocumentDto,
  FacilityListResponseDto,
  FacilityManagerOptionListResponseDto,
  FacilityStoreOptionListResponseDto,
  UpdateFacilityResponseDto,
} from './dto/facility.response.dto';
import {
  FacilitiesService,
  type FacilityDocumentUpload,
} from './facilities.service';
import {
  BULK_BUSY,
  BULK_BUSY_CODE,
  BULK_CELL_TOO_LONG,
  BULK_EMPTY,
  BULK_HAS_ERRORS,
  BULK_MAX_BYTES,
  BULK_NO_ERRORS,
  BULK_STORE_CHANGED,
  BULK_TEMPLATE_FILE_NAME,
  BULK_TEMPLATE_ONLY,
  BULK_TOO_COMPLEX,
  BULK_TOO_LARGE,
  BULK_TOO_MANY,
  BULK_UNREADABLE,
} from './facility-bulk';
import {
  BULK_CODES_MISSING,
  type BulkUpload,
  FacilityBulkService,
} from './facility-bulk.service';
import { FACILITY_DOCUMENT_MAX_BYTES } from './facility-format';

const BP_NOT_FOUND_DESCRIPTION =
  '플랫폼 계정이 보낸 X-Bp-Code-Id 가 존재하지 않는 · 지운 · 플랫폼 BP 이거나 형식이 틀림(가드)';
const NOT_FOUND_DESCRIPTION = `없거나 지운 시설물·장비 · 볼 수 없는 점포의 것 · ${BP_NOT_FOUND_DESCRIPTION}`;
const BP_MISSING_DESCRIPTION =
  '플랫폼 계정이 BP 를 고르지 않음(X-Bp-Code-Id 누락)';
const READ_ONLY_DESCRIPTION = '폐점 점포의 시설물·장비(조회만 된다)';
const KIND_PARAM = {
  name: 'kind',
  enum: FacilityDocumentKind,
  enumName: 'FacilityDocumentKind',
  description:
    '문서 종류 — 사용 매뉴얼 · 주의사항 · 제품 보증서. 모르는 값이면 404',
} as const;

/** 엑셀 일괄 등록이 받는 본문 — multipart 의 file 하나(.xlsx) */
const BULK_FILE_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};
const BULK_FILE_ERRORS = [
  '파일 없음 · 5MB 초과 · 파일 2개 이상(업로드 문구)',
  `zip · xlsx 가 아니거나 첫 시트 머리글이 양식과 다름(「${BULK_TEMPLATE_ONLY}」)`,
  `압축을 푼 크기가 16MB 를 넘음(「${BULK_TOO_LARGE}」)`,
  `exceljs 가 읽지 못함 — 표 · 차트 등(「${BULK_UNREADABLE}」)`,
  `파일을 읽는 worker 가 메모리(192MB) · 시간(15초) 상한을 넘음(「${BULK_TOO_COMPLEX}」)`,
  `보낼 셀 글자가 모두 400만 자를 넘음(「${BULK_TOO_LARGE}」 — 칸 하나가 1,000자를 넘으면 그 칸의 사유 「${BULK_CELL_TOO_LONG}」)`,
  `500줄 초과 또는 공백뿐인 줄까지 1,000행 초과(「${BULK_TOO_MANY}」)`,
  `내용 없음(「${BULK_EMPTY}」)`,
  `그 BP 의 시설물 공통코드가 없음(「${BULK_CODES_MISSING}」)`,
  BP_MISSING_DESCRIPTION,
].join(' · ');
/** 파일을 읽는 worker 자리가 없음 — 동시 2개 · 대기 8건 · 대기 30초 */
const BULK_BUSY_RESPONSE = {
  description: `파일을 읽는 요청이 몰림(「${BULK_BUSY}」). \`code: ${BULK_BUSY_CODE}\` — 저장하지 않았으니 다시 등록해도 된다. code 없는 503 은 앞단(게이트웨이 · 로드밸런서)이 낸 것일 수 있다`,
};
const XLSX_FILE_RESPONSE: ApiResponseOptions = {
  description: '.xlsx 파일(Content-Disposition 에 파일 이름)',
  schema: { type: 'string', format: 'binary' },
};

/**
 * 시설물·장비. 관리자 웹 「시설물 및 장비 관리」(`/facilities`, MN000022)는 경로마다 메뉴 권한(조회 · 등록 · 수정 · 삭제)을
 * 가드(@MenuPermission)가 판정하고, 업무 규칙(점포 범위 · 폐점 점포 조회만 · 공통코드 · 관리 담당자)은 FacilitiesService 가
 * 본다. 다루는 BP 는 가드가 X-Bp-Code-Id 로 정한다 — BP · 가맹 계정은 소속 BP, 플랫폼 계정은 헤더로 고객 BP 를 보내야 한다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 메뉴 권한 없음 · BP · 가맹 계정이 다른 BP 나 형식이 틀린 X-Bp-Code-Id 를 보냄',
})
@ApiBadRequestResponse({ description: BP_MISSING_DESCRIPTION })
@UserTypes('admin')
@Controller('facilities')
export class FacilitiesController {
  constructor(
    private readonly facilities: FacilitiesService,
    private readonly bulk: FacilityBulkService,
  ) {}

  /** 목록. 등록일 최신순, 한 쪽 50 · 100건. 분류는 그룹을 고른 경우에만 — 그룹 없이 보내면 400. */
  @Get()
  @MenuPermission('read')
  @ApiBadRequestResponse({
    description: `검색 조건 형식 · 그룹 없이 분류 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  list(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListFacilitiesQueryDto,
  ): Promise<FacilityListResponseDto> {
    return this.facilities.list(user.id, bp, query);
  }

  /** 점포 선택지 — 범위 안의 점포. 등록 화면은 폐점을 빼고(기본), 목록 필터는 `includeClosed=true`. `:id` 보다 먼저 둔다. */
  @Get('store-options')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  storeOptions(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: FacilityStoreOptionsQueryDto,
  ): Promise<FacilityStoreOptionListResponseDto> {
    return this.facilities.storeOptions(user.id, bp, query);
  }

  /** 관리 담당자 선택지 — 그 점포의 재직 직원(이름 · 휴대폰). 퇴직자는 빠진다. */
  @Get('manager-options')
  @MenuPermission('read')
  @ApiNotFoundResponse({
    description: `볼 수 없는 점포 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  managerOptions(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Query() query: FacilityManagerOptionsQueryDto,
  ): Promise<FacilityManagerOptionListResponseDto> {
    return this.facilities.managerOptions(user.id, bp, query);
  }

  /**
   * 엑셀 일괄 등록 양식(PL-7). 첫 시트에 24칸 · 드롭다운, 둘째 시트에 범위 안 열린 점포. 일괄 등록 네 경로는 모두 등록
   * 권한이고 `:id` 보다 먼저 둔다. 파일은 서버에 남기지 않는다 — 미리보기 · 오류 파일 · 등록마다 같은 파일을 다시 보낸다.
   */
  @Get('bulk-template')
  @MenuPermission('create')
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse(XLSX_FILE_RESPONSE)
  @ApiBadRequestResponse({
    description: `그 BP 의 시설물 공통코드가 없음(「${BULK_CODES_MISSING}」) · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  async bulkTemplate(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<StreamableFile> {
    return xlsxFile(
      await this.bulk.template(user.id, bp),
      BULK_TEMPLATE_FILE_NAME,
    );
  }

  /** 일괄 등록 미리보기 — 올린 파일을 검사해 줄마다 결과 · 보일 글자 · 오류 사유. 저장하지 않는다. */
  @Post('bulk-validations')
  @MenuPermission('create')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AttachmentsInterceptor('file', 1, BULK_MAX_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiBody(BULK_FILE_BODY)
  @ApiOkResponse({ type: BulkPreviewResponseDto })
  @ApiBadRequestResponse({ description: BULK_FILE_ERRORS })
  @ApiServiceUnavailableResponse(BULK_BUSY_RESPONSE)
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  bulkValidations(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @UploadedFiles() files: BulkUpload[] | undefined,
  ): Promise<BulkPreviewResponseDto> {
    return this.bulk.preview(user.id, bp, files?.[0]);
  }

  /** 일괄 등록 오류 파일 — 올린 파일 끝에 「오류 사유」 열을 더해 돌려준다(이름 「올린파일이름_오류.xlsx」). 오류 줄이 없으면 400. */
  @Post('bulk-error-file')
  @MenuPermission('create')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AttachmentsInterceptor('file', 1, BULK_MAX_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiBody(BULK_FILE_BODY)
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse(XLSX_FILE_RESPONSE)
  @ApiBadRequestResponse({
    description: `${BULK_FILE_ERRORS} · 오류가 있는 줄이 없음(「${BULK_NO_ERRORS}」)`,
  })
  @ApiServiceUnavailableResponse(BULK_BUSY_RESPONSE)
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  async bulkErrorFile(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @UploadedFiles() files: BulkUpload[] | undefined,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.bulk.errorFile(
      user.id,
      bp,
      files?.[0],
    );
    return xlsxFile(buffer, fileName);
  }

  /**
   * 일괄 등록 — 같은 검사를 다시 하고, 오류가 한 줄이라도 있으면 하나도 저장하지 않고 400. 모두 정상이면 한 트랜잭션.
   * 미리보기 뒤 등록 요청 전에 점포가 폐점 · 삭제되거나 공통코드가 미사용이 됐으면 줄 오류로 400, 검사 뒤 넣기 직전에
   * 점포가 폐점 · 삭제됐으면 점포 변경 문구로 400 이다 — 화면은 미리보기를 다시 받는다.
   */
  @Post('bulk')
  @MenuPermission('create')
  @UseInterceptors(AttachmentsInterceptor('file', 1, BULK_MAX_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiBody(BULK_FILE_BODY)
  @ApiCreatedResponse({ type: BulkCreateResponseDto })
  @ApiBadRequestResponse({
    description: `${BULK_FILE_ERRORS} · 오류가 있는 줄이 있음(「${BULK_HAS_ERRORS}」) · 검사 뒤 점포가 폐점 · 삭제됨(「${BULK_STORE_CHANGED}」)`,
  })
  @ApiServiceUnavailableResponse(BULK_BUSY_RESPONSE)
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  bulkRegister(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @UploadedFiles() files: BulkUpload[] | undefined,
  ): Promise<BulkCreateResponseDto> {
    return this.bulk.register(user.id, bp, files?.[0]);
  }

  @Get(':id')
  @MenuPermission('read')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  detail(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<FacilityDetailResponseDto> {
    return this.facilities.detail(user.id, bp, idOf(rawId));
  }

  /** 등록. 문서는 등록한 뒤 `PUT /facilities/:id/documents/:kind` 로 올린다. */
  @Post()
  @MenuPermission('create')
  @ApiBadRequestResponse({
    description: `입력 형식 · 고를 수 없는 점포(범위 밖) · 폐점 점포 · 쓸 수 없는 운영상태 · 분류 · 점검 주기 · 설치일이 구매일보다 앞섬 · A/S센터 주소 짝이 맞지 않음 · 그 점포 재직 직원이 아닌 관리 담당자 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  create(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Body() body: CreateFacilityDto,
  ): Promise<CreateFacilityResponseDto> {
    return this.facilities.create(user.id, bp, body);
  }

  /**
   * 수정. 화면 전체를 다시 보낸다 — 빠지거나 빈 선택 칸은 지운다. 점포는 바꿀 수 없다. 상세에서 받은 updatedAt 을 함께
   * 보낸다(그 사이 다른 사람이 고쳤으면 409). 지금 값인 미사용 분류 · 점검 주기와 퇴직한 담당자는 그대로 둘 수 있다.
   */
  @Put(':id')
  @MenuPermission('update')
  @ApiBadRequestResponse({
    description: `입력 형식(점포를 보내도 400) · 쓸 수 없는 운영상태 · 분류 · 점검 주기 · 설치일이 구매일보다 앞섬 · A/S센터 주소 짝 · 재직 직원이 아닌 관리 담당자 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: `동시 수정 · ${READ_ONLY_DESCRIPTION}` })
  update(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Body() body: UpdateFacilityDto,
  ): Promise<UpdateFacilityResponseDto> {
    return this.facilities.update(user.id, bp, idOf(rawId), body);
  }

  /** 삭제(논리 삭제). 문서도 함께 지움 표시한다. 잘못 등록한 것을 지우는 용도다 — 옮기거나 그만 쓰면 폐기로 바꾼다. */
  @Delete(':id')
  @MenuPermission('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: READ_ONLY_DESCRIPTION })
  async remove(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.facilities.remove(user.id, bp, idOf(rawId));
  }

  /**
   * 문서 올리기 · 바꾸기(종류마다 1개). multipart 의 `file` 한 개, JPG · PNG · PDF 10MB 이하 — 종류는 확장자가 아니라
   * 내용으로 본다. 등록 화면은 등록한 뒤 이 경로로 올리므로 가드는 등록 또는 수정 권한을 받고, 서비스가 좁힌다 — 등록
   * 권한만 있으면 직접 등록한 시설물에 그 종류 문서가 아직 없을 때만(처음 올리기), 교체 · 남의 시설물은 수정 권한.
   */
  @Put(':id/documents/:kind')
  @MenuPermission(['create', 'update'])
  @UseInterceptors(
    AttachmentsInterceptor('file', 1, FACILITY_DOCUMENT_MAX_BYTES),
  )
  @ApiParam(KIND_PARAM)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: FacilityDocumentDto })
  @ApiBadRequestResponse({
    description: `파일 없음 · JPG · PNG · PDF 가 아님 · 10MB 초과 · 파일 2개 이상 · 썸네일을 만들 수 없는 그림(깨짐 · 화소 초과) · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: `${NOT_FOUND_DESCRIPTION} · 문서 종류` })
  @ApiConflictResponse({ description: READ_ONLY_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '메뉴 권한 없음(가드) · 등록 권한만 있는데 이미 있는 문서를 바꾸거나 남이 등록한 시설물에 올림(수정 권한 필요)',
  })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않았거나 올리기에 실패함',
  })
  putDocument(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Param('kind') kind: string,
    @UploadedFiles() files: FacilityDocumentUpload[] | undefined,
  ): Promise<FacilityDocumentDto> {
    return this.facilities.putDocument(
      user.id,
      bp,
      idOf(rawId),
      kind,
      files?.[0],
    );
  }

  /** 문서 빼기. 없어도 204. */
  @Delete(':id/documents/:kind')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam(KIND_PARAM)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: `${NOT_FOUND_DESCRIPTION} · 문서 종류` })
  @ApiConflictResponse({ description: READ_ONLY_DESCRIPTION })
  async removeDocument(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('id') rawId: string,
    @Param('kind') kind: string,
  ): Promise<void> {
    await this.facilities.removeDocument(user.id, bp, idOf(rawId), kind);
  }
}

/** .xlsx 응답 — 엑셀 내려받기와 같은 Content-Type · Content-Disposition */
function xlsxFile(buffer: Buffer, fileName: string): StreamableFile {
  return new StreamableFile(buffer, {
    type: XLSX_CONTENT_TYPE,
    disposition: contentDisposition(fileName),
    length: buffer.length,
  });
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null)
    throw new NotFoundException('시설물·장비를 찾을 수 없습니다');
  return id;
}
