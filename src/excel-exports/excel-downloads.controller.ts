import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
 * 예약 생성한 엑셀 내려받기 — 메일 링크(관리자 웹 `/excel-downloads/{id}`)가 로그인한 채 부른다. 메뉴가 아니라 「요청한
 * 본인」이 권한이다: 다른 사람 · 바로 받기 · 없는 것은 모두 404. 엑셀을 요청할 때 그 화면의 메뉴 권한을 이미 봤다.
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
