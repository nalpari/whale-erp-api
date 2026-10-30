import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import { signedInUserTracker } from '../auth/throttle';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { AffiliationRequestsService } from './affiliation-requests.service';
import {
  AcceptAffiliationRequestDto,
  AcceptAffiliationResponseDto,
  AffiliationRequestDto,
} from './dto/affiliation-request.dto';

const ID = new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

// 로그인한 직원의 소속 추가 확인 요청(WHALEERP-130 · 144, 2026-10-26 재영). 요청은 그 번호의 계정(후보 계정)에 걸려 링크에
// 토큰이 없다 — 로그인해야 보이고 답할 수 있다. 요청 제한은 답하기(수락 · 거절)에만 근무지 더하기와 같은 계정 축으로 건다 —
// 목록은 앱이 로그인 · 화면을 열 때마다 읽는 읽기라 묶지 않는다(GET /auth/account/me 와 같다).
const ANSWER_LIMIT = {
  account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
};

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/affiliation-requests')
export class MyAffiliationRequestsController {
  constructor(private readonly requests: AffiliationRequestsService) {}

  /**
   * 내 살아 있는 소속 추가 확인 요청 — 보냄 · 기한 안. 로그인 뒤 팝업과 나의 정보 - 소속 점포가 이 목록을 보인다. 없으면 빈 배열
   */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<AffiliationRequestDto[]> {
    // @UserTypes('account') 가 막지만 타입은 그것을 모른다.
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.requests.list(user.id);
  }

  /**
   * 수락 — 그 점포의 직원 레코드를 이 계정에 잇고(가입 완료) 함께 온 근로계약서를 서명 대기로 넘긴다. 날인 기한은 지금부터 30일,
   * 날인 요청 직원 알림이 나간다.
   */
  @Post(':invitationId/accept')
  @UseGuards(ThrottlerGuard)
  @Throttle(ANSWER_LIMIT)
  @ApiTooManyRequestsResponse({ description: '계정마다 10분에 10번' })
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({ description: '형식 오류' })
  @ApiNotFoundResponse({
    description:
      '없거나 내 것이 아닌 요청(AFFILIATION_REQUEST_NOT_FOUND) · 만료 · 번호가 바뀐 요청(AFFILIATION_REQUEST_ENDED)',
  })
  @ApiConflictResponse({
    description:
      '이미 답한 요청(AFFILIATION_REQUEST_ANSWERED) · 이 점포에 이미 재직 중',
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('invitationId', ID) invitationId: number,
    @Body() dto: AcceptAffiliationRequestDto,
  ): Promise<AcceptAffiliationResponseDto> {
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.requests.accept(user.id, invitationId, dto);
  }

  /**
   * 거절 — 요청을 거절로 두고(사유 선택) 함께 온 근로계약서를 거부로 닫는다(같은 사유). 직원 레코드 · 지금 소속 · 계정은 그대로다.
   * 초안을 쓴 관리자에게 「소속 추가 확인 거절」 운영 알림이 간다.
   */
  @Post(':invitationId/reject')
  @UseGuards(ThrottlerGuard)
  @Throttle(ANSWER_LIMIT)
  @ApiTooManyRequestsResponse({ description: '계정마다 10분에 10번' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: '형식 오류(요청 ID)' })
  @ApiNotFoundResponse({
    description:
      'AFFILIATION_REQUEST_NOT_FOUND · AFFILIATION_REQUEST_ENDED — 수락과 같다',
  })
  @ApiConflictResponse({
    description: '이미 답한 요청(AFFILIATION_REQUEST_ANSWERED)',
  })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('invitationId', ID) invitationId: number,
  ): Promise<void> {
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.requests.reject(user.id, invitationId);
  }
}
