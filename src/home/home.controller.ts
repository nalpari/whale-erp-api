import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { HomeQueryDto } from './dto/home-query.dto';
import {
  HomePendingResponseDto,
  HomeSummaryResponseDto,
} from './dto/home.response.dto';
import { HomeService } from './home.service';

/**
 * 관리자 웹 로그인 후 홈의 집계(WHALEERP-305 · 306). 홈은 메뉴가 아니라 @MenuPermission 을 달지 않는다 — 관리자 토큰이면
 * 부르고, 영역마다 그 메뉴의 조회 권한이 없으면 그 영역만 null 이다(서비스가 본다). 직원 앱 토큰은 403.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@ApiBadRequestResponse({ description: 'storeIds 형식 오류' })
@UserTypes('admin')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** 수치 카드 넷 · 점포별 현황 표(미조치 많은 순 일곱 곳 + 전체 수) */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: HomeQueryDto,
  ): Promise<HomeSummaryResponseDto> {
    return this.home.summary(user.id, query.storeIds);
  }

  /** 경고 밴드(갱신 예정 7일 안) · 처리 대기 유형 목록 */
  @Get('pending')
  pending(
    @CurrentUser() user: AuthUser,
    @Query() query: HomeQueryDto,
  ): Promise<HomePendingResponseDto> {
    return this.home.pending(user.id, query.storeIds);
  }
}
