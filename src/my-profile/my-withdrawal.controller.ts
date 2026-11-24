import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AccountUser } from '../auth/auth.types';
import { signedInUserTracker } from '../auth/throttle';
import { WithdrawMyAccountDto } from './dto/my-withdrawal.dto';
import {
  MyWithdrawalConflictResponseDto,
  MyWithdrawalEligibilityResponseDto,
} from './dto/my-withdrawal.response.dto';
import { MyWithdrawalService } from './my-withdrawal.service';

/** 직원 근무 앱 회원 탈퇴 (WHALEERP-770) — 내 정보(`/me/profile`) 아래 */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/profile')
export class MyWithdrawalController {
  constructor(private readonly withdrawals: MyWithdrawalService) {}

  /**
   * 탈퇴 전 조건. 재직 중인 근무지(퇴직 예정 포함)가 하나라도 있으면 `canWithdraw` 는 false 이고 근무지 · 퇴직일을 준다 — 화면이
   * 「근무지 관리자에게 퇴직 처리를 요청해 주세요」와 함께 보인다. `pendingContractCount` 는 탈퇴하면 종료되는 대기 중 근로계약 수다
   */
  @Get('withdrawal-eligibility')
  @ApiOkResponse({ type: MyWithdrawalEligibilityResponseDto })
  getEligibility(
    @CurrentUser() user: AccountUser,
  ): Promise<MyWithdrawalEligibilityResponseDto> {
    return this.withdrawals.getEligibility(user.id);
  }

  /**
   * 회원 탈퇴. 지금 비밀번호가 맞고 재직 중인 근무지가 없으면 즉시 탈퇴한다 — 개인정보 · 위치정보를 지우고 모든 기기의 접속을
   * 끊는다(되돌릴 수 없다). 근로계약서 · 급여명세서 · 출퇴근 기록은 근무지 데이터로 남는다
   */
  // 계정마다 10분에 10번 — 훔친 토큰으로 지금 비밀번호를 맞혀 보는 것을 늦춘다. 틀려도 로그인 잠금 횟수는 세지 않는다.
  @Post('withdrawal')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @ApiNoContentResponse({ description: '탈퇴함' })
  @ApiBadRequestResponse({ description: '지금 비밀번호가 맞지 않음' })
  @ApiConflictResponse({
    type: MyWithdrawalConflictResponseDto,
    description:
      '재직 중인 근무지가 있음(code EMPLOYED_AFFILIATION, employedStores 에 근무지 · 퇴직일) · 다른 처리와 겹침(다시 시도)',
  })
  @ApiTooManyRequestsResponse({ description: '계정 · IP 요청 한도' })
  withdraw(
    @CurrentUser() user: AccountUser,
    @Body() body: WithdrawMyAccountDto,
  ): Promise<void> {
    return this.withdrawals.withdraw(user.id, body.currentPassword);
  }
}
