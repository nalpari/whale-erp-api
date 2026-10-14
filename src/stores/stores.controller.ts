import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import {
  type MenuAction,
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { contentDisposition } from '../storage/storage.service';
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
import { XLSX_CONTENT_TYPE } from './store-excel';
import { STORE_MENU } from './store-format';
import {
  STORE_IMAGE_MAX_BYTES,
  StoreManagementService,
  type StoreImageUpload,
} from './store-management.service';
import { StoresService } from './stores.service';

const NOT_FOUND_DESCRIPTION = '없거나 지운 점포 · 볼 수 없는 점포';

/**
 * 점포. 관리자 웹 「점포 정보 관리」(MN000002)는 메뉴 권한(조회 · 등록 · 수정 · 삭제)으로 동작마다 판정하고,
 * 업무 규칙(범위 · 상태 · BP 사용 여부 · 가맹 역할 등록 금지)은 StoreManagementService 가 본다.
 * 근로계약서 근무지 선택지(`/stores/options`)는 메뉴 권한 없이 업무 범위로만 거른다 — 근로계약 화면이 쓴다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 메뉴 권한 없음 · 가맹 계정의 등록',
})
@UserTypes('admin')
@Controller('stores')
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly management: StoreManagementService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  /** 근무지 선택지. 업무 범위 안에서 지우지 않았고 폐점이 아닌 점포, 이름순. `:id` 보다 먼저 둔다. */
  @Get('options')
  @ApiOkResponse({ type: StoreOptionListResponseDto })
  options(
    @Query() query: ListStoreOptionsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StoreOptionListResponseDto> {
    return this.stores.options(user.id, query);
  }

  /** 점포 정보 관리 목록. 등록일 최신순, 기본은 미운영 · 운영. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListStoresQueryDto,
  ): Promise<StoreListResponseDto> {
    return this.management.list(await this.allow(user, 'read'), query);
  }

  /**
   * 엑셀 바로 받기(xlsx). 목록과 같은 검색 조건으로 전부 담고, 대표자 연락처만 가운데 자리를 가린다.
   * 1만 건 이상은 400(예약 생성은 아직 없다), 한 사람 1분에 한 번(429). `:id` 보다 먼저 둔다.
   */
  @Get('excel')
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: '점포목록_YYYYMMDD.xlsx',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiBadRequestResponse({ description: '검색 조건 형식 · 1만 건 이상' })
  @ApiTooManyRequestsResponse({ description: '1분 안에 다시 받음' })
  async excel(
    @CurrentUser() user: AuthUser,
    @Query() query: StoreExcelQueryDto,
  ): Promise<StreamableFile> {
    const { fileName, buffer } = await this.management.excel(
      await this.allow(user, 'read'),
      query,
    );
    return new StreamableFile(buffer, {
      type: XLSX_CONTENT_TYPE,
      disposition: contentDisposition(fileName),
      length: buffer.length,
    });
  }

  /**
   * 저장 전 사업자 인증 확인. 등록 또는 수정 권한이 있으면 된다. 저장할 때 서버가 다시 확인하므로 이 결과는
   * 화면 안내용이다.
   */
  @Post('business-verifications')
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiServiceUnavailableResponse({
    description: '사업자 진위확인 연동이 없거나 실패함',
  })
  async verifyBusiness(
    @CurrentUser() user: AuthUser,
    @Body() body: VerifyStoreBusinessDto,
  ): Promise<StoreBusinessVerificationResponseDto> {
    const caller = await this.allow(user, 'create').catch((error: unknown) => {
      if (error instanceof ForbiddenException)
        return this.allow(user, 'update');
      throw error;
    });
    return this.management.verifyBusiness(caller, body);
  }

  @Get(':id')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StoreDetailResponseDto> {
    const id = idOf(rawId);
    return this.management.detail(await this.allow(user, 'read'), id);
  }

  /** 변경 이력. 보존 기한(5년) 안의 것, 최신순. */
  @Get(':id/histories')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async histories(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Query() query: StoreHistoryPageDto,
  ): Promise<StoreHistoryListResponseDto> {
    const id = idOf(rawId);
    return this.management.histories(await this.allow(user, 'read'), id, query);
  }

  /** 운영 · 폐점 · 삭제를 지금 할 수 있는가. 수정 화면이 폐점을 고를 때 다시 묻는다. */
  @Get(':id/transition-check')
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  async transitionCheck(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StoreTransitionCheckResponseDto> {
    const id = idOf(rawId);
    return this.management.transitionCheck(await this.allow(user, 'read'), id);
  }

  /** 등록. 늘 미운영으로 만들고 점포코드를 채번한다. 가맹 계정은 403. */
  @Post()
  @ApiBadRequestResponse({
    description: '입력 형식 · BP 를 고르지 않음(플랫폼) · 국세청 정보와 다름',
  })
  @ApiConflictResponse({
    description: '소속 BP 미사용 · 사업자등록번호 중복',
  })
  @ApiServiceUnavailableResponse({
    description: '사업자 인증을 보냈는데 진위확인 연동이 없거나 실패함',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateStoreDto,
  ): Promise<CreateStoreResponseDto> {
    return this.management.create(await this.allow(user, 'create'), body);
  }

  /** 수정 · 상태 전환. 상세에서 받은 updatedAt 을 함께 보낸다 — 그 사이 다른 사람이 고쳤으면 409. */
  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({
    description:
      '입력 형식 · 바꿀 수 없는 상태 전환 · 운영 조건(인증 · 좌표) 미충족 · 국세청 정보와 다름 · 재인증 번호 불일치',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '동시 수정 · 폐점한 점포 · 소속 BP 미사용 · 진행 중인 근로계약(폐점) · 사업자등록번호 중복',
  })
  @ApiServiceUnavailableResponse({
    description: '사업자 인증을 보냈는데 진위확인 연동이 없거나 실패함',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: UpdateStoreDto,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.management.update(await this.allow(user, 'update'), id, body);
  }

  /** 삭제(논리 삭제). 미운영이면서 진행 중인 근로계약이 없을 때만. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({
    description:
      '미운영이 아님 · 진행 중인 근로계약 · 소속 BP 미사용 · 그 사이 지워지거나 상태가 바뀜',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.management.remove(await this.allow(user, 'delete'), id);
  }

  /**
   * 대표 이미지 올리기 · 바꾸기(점포당 1장). multipart 의 `file` 한 개, JPG · PNG 5MB 이하 — 종류는 확장자가
   * 아니라 내용으로 본다. 등록 화면은 점포를 등록한 뒤 이 경로로 올린다. 수정 권한이 있어야 한다.
   */
  @Put(':id/image')
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
    description: '파일 없음 · JPG · PNG 가 아님 · 5MB 초과 · 파일 2개 이상',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '폐점한 점포 · 소속 BP 미사용' })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않았거나 올리기에 실패함',
  })
  async putImage(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @UploadedFiles() files: StoreImageUpload[] | undefined,
  ): Promise<StoreImageResponseDto> {
    const id = idOf(rawId);
    return this.management.putImage(
      await this.allow(user, 'update'),
      id,
      files?.[0],
    );
  }

  /** 대표 이미지 지우기. 이미지가 없어도 204. 수정 권한이 있어야 한다. */
  @Delete(':id/image')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: NOT_FOUND_DESCRIPTION })
  @ApiConflictResponse({ description: '폐점한 점포 · 소속 BP 미사용' })
  async removeImage(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<void> {
    const id = idOf(rawId);
    await this.management.removeImage(await this.allow(user, 'update'), id);
  }

  private allow(user: AuthUser, action: MenuAction): Promise<MenuCaller> {
    return this.permissions.assert(user.id, STORE_MENU, action);
  }
}

/** 1..2147483647 밖이면 DB 에 묻지 않고 404 — Postgres 가 던지면 500 이 된다. */
function idOf(raw: string): number {
  const id = parseRouteId(raw);
  if (id === null) throw new NotFoundException('점포를 찾을 수 없습니다');
  return id;
}
