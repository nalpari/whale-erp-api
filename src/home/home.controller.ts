import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { BP_HEADER } from '../auth/menu-permission.guard';
import { HomeQueryDto } from './dto/home-query.dto';
import {
  HomePendingResponseDto,
  HomeSummaryResponseDto,
} from './dto/home.response.dto';
import { HomeService } from './home.service';

type BpHeaderRequest = {
  headers: Record<string, string | string[] | undefined>;
};
/** 탭 BP 헤더 — @Headers 는 swagger 에 필수 헤더로 한 번 더 적혀 요청에서 읽는다. 두 번 온 헤더(배열)는 어느 BP 도 아니다(404) */
const bpOf = (req: BpHeaderRequest): string | undefined => {
  const raw = req.headers[BP_HEADER.toLowerCase()];
  return Array.isArray(raw) ? '' : raw;
};

/**
 * 관리자 웹 로그인 후 홈의 집계(WHALEERP-305 · 306). 홈은 메뉴가 아니라 @MenuPermission 을 달지 않는다 — 관리자 토큰이면
 * 부르고, 영역마다 그 메뉴의 조회 권한이 없으면 그 영역만 null 이다(서비스가 본다). 직원 앱 토큰은 403.
 * 가드가 탭 BP 를 정하지 않으므로 플랫폼 계정이 고른 고객 BP 는 `X-Bp-Code-Id` 헤더를 서비스가 직접 본다(WHALEERP-667).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@ApiBadRequestResponse({ description: 'storeIds 형식 오류' })
@ApiNotFoundResponse({
  description: '플랫폼 계정이 보낸 탭 BP 가 없거나 지웠거나 플랫폼 BP 임',
})
@ApiHeader({
  name: BP_HEADER,
  required: false,
  description:
    '탭 BP — 플랫폼 계정이 고른 고객 BP. 없으면 플랫폼 계정은 platform: true 인 빈 결과다. BP · 가맹 계정은 보지 않는다',
})
@UserTypes('admin')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** 수치 카드 · 점포별 현황 표(확인 필요 많은 순, 운영 점포 모두) */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: HomeQueryDto,
    @Req() req: BpHeaderRequest,
  ): Promise<HomeSummaryResponseDto> {
    return this.home.summary(user.id, query.storeIds, new Date(), bpOf(req));
  }

  /** 확인 필요 유형 목록 */
  @Get('pending')
  pending(
    @CurrentUser() user: AuthUser,
    @Query() query: HomeQueryDto,
    @Req() req: BpHeaderRequest,
  ): Promise<HomePendingResponseDto> {
    return this.home.pending(user.id, query.storeIds, new Date(), bpOf(req));
  }
}
