import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import { ExcelDownloadLinkResponseDto } from './dto/excel-export.response.dto';
import { ExcelExportsService } from './excel-exports.service';

/**
 * 예약 생성한 엑셀 내려받기 — 메일 링크(관리자 웹 `/excel-downloads/{id}`)가 로그인한 채 부른다. 「요청한 본인」만
 * 받는다: 다른 사람 · 바로 받기 · 없는 것은 모두 404. 메뉴가 경로가 아니라 이력의 menu_id 로 정해져 메뉴 가드를 달 수
 * 없으므로, 서비스가 그 화면의 조회 권한 · 계정 · 화면의 호출자 조건을 받을 때 다시 본다(잃었으면 403).
 */
@ApiBearerAuth()
@UserTypes('admin')
@Controller('excel-downloads')
export class ExcelDownloadsController {
  constructor(private readonly exports: ExcelExportsService) {}

  /** 내려받기 주소(5분). 받은 시각을 이력에 남긴다. */
  @Get(':id')
  @ApiNotFoundResponse({ description: '없음 · 요청한 본인이 아님 · 바로 받기' })
  @ApiConflictResponse({ description: '아직 만드는 중 · 만들지 못함' })
  @ApiGoneResponse({ description: '내려받기 기한(24시간)이 지남' })
  @ApiForbiddenResponse({
    description:
      '그 화면의 조회 권한을 잃음 · 쓸 수 없는 계정 · 화면의 호출자 조건을 잃음(예: BP 목록은 플랫폼 계정)',
  })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소(AWS_S3_*)가 설정되지 않음',
  })
  download(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<ExcelDownloadLinkResponseDto> {
    const id = parseRouteId(rawId);
    if (id === null)
      throw new NotFoundException('엑셀 파일을 찾을 수 없습니다');
    return this.exports.download(user.id, id);
  }
}
