import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { UserTypes } from '../auth/auth.decorators';
import { MenuPermission } from '../auth/menu-permission.guard';
import { ListPublicHolidaysQueryDto } from './dto/list-public-holidays-query.dto';
import { PublicHolidayListResponseDto } from './dto/public-holiday.response.dto';
import { PublicHolidaysService } from './public-holidays.service';

/**
 * 플랫폼 휴일 관리(`/public-holidays`, 현재 MN000217) — 대한민국 공식 휴일 조회 전용(S-DDGJKQ).
 * @MenuPermission 으로 메뉴 조회 권한을 보고, platformOnly 로 호출자가 플랫폼 BP 의 사용 중 PM · PA 인지도 본다.
 * 등록 · 수정 · 삭제 경로는 두지 않는다 — 공식 휴일은 규칙 계산과 공공 API 동기화로만 바뀐다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '메뉴 권한 없음 · 플랫폼 계정이 아님(공용 문구)',
})
@UserTypes('admin')
@Controller('public-holidays')
export class PublicHolidaysController {
  constructor(private readonly holidays: PublicHolidaysService) {}

  /** 공식 휴일 — 월을 주면 그 달(캘린더), 없으면 그 해 전체(목록). 날짜순, 페이지 없이. */
  @Get()
  @MenuPermission('read', { platformOnly: true })
  @ApiBadRequestResponse({ description: '연도 2000~2100 · 월 1~12 밖' })
  async list(
    @Query() query: ListPublicHolidaysQueryDto,
  ): Promise<PublicHolidayListResponseDto> {
    return this.holidays.list(query);
  }
}
