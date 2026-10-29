import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { BulkExportsService } from './bulk-exports.service';
import {
  BulkExportDownloadResponseDto,
  BulkExportItemDto,
  BulkExportListQueryDto,
  BulkExportListResponseDto,
  BulkExportPreviewQueryDto,
  BulkExportPreviewResponseDto,
  CreateBulkExportDto,
} from './dto/bulk-export.dto';

/**
 * 직원 자료 일괄 저장(WHALEERP-336). 직원 정보 관리 메뉴(`/staff-members`)의 조회 권한 위에서 권한 유형을 따로 본다 — BP
 * 마스터 · 가맹마스터만, 그 밖은 403. `/staff-members/:id` 보다 먼저 등록돼야 한다(AppModule 에서 StaffMembersModule 앞).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 정보 관리 조회 권한 없음 · BP 마스터 · 가맹마스터가 아님 · 직원 앱 토큰 · 쓸 수 없는 계정',
})
@MenuPermission('read')
@Controller('staff-members/bulk-exports')
export class BulkExportsController {
  constructor(private readonly exports: BulkExportsService) {}

  /** 담을 직원 수(재직 · 퇴직)와 범위 점포 수. 0 이면 화면이 요청 버튼을 끈다 */
  @Get('preview')
  @ApiBadRequestResponse({
    description: '관리하지 않는 점포가 섞임 · 형식 오류',
  })
  preview(
    @CurrentUser() user: AuthUser,
    @Query() query: BulkExportPreviewQueryDto,
  ): Promise<BulkExportPreviewResponseDto> {
    return this.exports.preview(user.id, query.storeIds);
  }

  /** 요청. 1분 배치가 만든다 */
  @Post()
  @ApiBadRequestResponse({
    description: '관리하지 않는 점포가 섞임 · 담을 직원이 없음 · 형식 오류',
  })
  @ApiConflictResponse({ description: '같은 범위의 파일을 만드는 중' })
  @ApiServiceUnavailableResponse({ description: '저장소(AWS_S3_*) 설정 없음' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateBulkExportDto,
  ): Promise<BulkExportItemDto> {
    return this.exports.request(user.id, body.storeIds);
  }

  /** 볼 수 있는 요청 — 같은 BP · 같은 권한 유형이고 요청의 점포를 모두 관리하는 마스터. 최근 순 */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: BulkExportListQueryDto,
  ): Promise<BulkExportListResponseDto> {
    return this.exports.list(user.id, query.page, query.pageSize);
  }

  /** 5분짜리 내려받기 주소. 내려받기 이력을 남긴다 */
  @Post(':id/download')
  @HttpCode(200)
  @ApiNotFoundResponse({ description: '없음 · 볼 수 없는 요청 · ID 형식 오류' })
  @ApiConflictResponse({
    description:
      '아직 만드는 중 · 만들지 못함 · BP 마스터 파일에 담긴 직원의 본사 제공 동의나 가맹 점포 상태가 바뀜',
  })
  @ApiGoneResponse({ description: '받을 수 있는 기한(7일)이 지남' })
  download(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<BulkExportDownloadResponseDto> {
    const id = parseRouteId(rawId);
    if (id === null)
      throw new NotFoundException('일괄 저장 파일을 찾을 수 없습니다.');
    return this.exports.download(user.id, id);
  }
}
