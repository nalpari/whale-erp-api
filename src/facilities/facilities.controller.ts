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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
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
import { AttachmentsInterceptor } from '../storage/upload-check';
import {
  FacilityManagerOptionsQueryDto,
  FacilityStoreOptionsQueryDto,
  ListFacilitiesQueryDto,
} from './dto/list-facilities-query.dto';
import { CreateFacilityDto, UpdateFacilityDto } from './dto/save-facility.dto';
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
  constructor(private readonly facilities: FacilitiesService) {}

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
   * 내용으로 본다. 등록 화면은 등록한 뒤 이 경로로 올리므로 등록 또는 수정 권한이면 된다.
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

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null)
    throw new NotFoundException('시설물·장비를 찾을 수 없습니다');
  return id;
}
