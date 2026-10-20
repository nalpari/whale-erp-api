import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { InvitationCheckResponseDto } from './dto/invitation-check.response.dto';
import {
  AcceptMyInvitationDto,
  AcceptMyInvitationResponseDto,
  MyInvitationLookupDto,
} from './dto/my-invitation.dto';
import { StaffSignupService } from './staff-signup.service';

// 로그인 뒤 다른 근무지의 초대로 그 근무지를 더한다(WHALEERP-603). 코드 대입은 계정 번호 기준 잠금(5회 · 30분)이 막고,
// 따로 IP 제한은 두지 않는다(운영 정책 JOI-02 v158, 2026-10-20 재영) — AuthModule 기본 요청 제한만 받는다.
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UseGuards(ThrottlerGuard)
@UserTypes('account')
@Controller('me/invitations')
export class MyInvitationsController {
  constructor(private readonly signups: StaffSignupService) {}

  /**
   * 초대 확인 — 앱 안에서 넣은 초대 코드(계정의 번호로 찾는다) 또는 로그인한 채 연 초대 링크의 토큰. 근무지 · 고용 형태 ·
   * 유효 기간과 본사 제공 동의를 물을지(직영이 아니고 계정이 아직 동의하지 않았을 때) 준다.
   */
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({
    description: '형식 오류 · 토큰과 코드를 함께 보내거나 둘 다 없음',
  })
  @ApiNotFoundResponse({
    description:
      '맞는 초대가 없음(INVITATION_NOT_FOUND — 코드가 틀림, 링크의 초대 번호가 계정 번호와 다름) · 끝난 초대(INVITATION_ENDED)',
  })
  @ApiConflictResponse({
    description: '이미 가입을 마친 초대(INVITATION_ALREADY_JOINED)',
  })
  @ApiTooManyRequestsResponse({
    description:
      '계정 번호로 코드를 5번 틀려 30분 잠김(INVITATION_CODE_LOCKED, 본문 lockExpiresAt — 재발송하면 풀림) · 기본 요청 제한',
  })
  check(
    @CurrentUser() user: AuthUser,
    @Body() dto: MyInvitationLookupDto,
  ): Promise<InvitationCheckResponseDto> {
    // @UserTypes('account') 가 막지만 타입은 그것을 모른다.
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.signups.checkForAccount(user.id, dto);
  }

  /**
   * 근무지 더하기 — 초대를 다시 확인하고 그 근무지의 직원 레코드를 이 계정에 잇는다(가입 완료 · 초대 수락). 가입을 기다리던
   * 근로계약서는 서명 대기가 된다.
   */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({
    description: '형식 오류 · 토큰과 코드를 함께 보내거나 둘 다 없음',
  })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND · INVITATION_ENDED — 확인과 같다',
  })
  @ApiConflictResponse({
    description: 'INVITATION_ALREADY_JOINED — 먼저 더했거나 같은 초대로 동시에',
  })
  @ApiTooManyRequestsResponse({
    description:
      '계정 번호로 코드를 5번 틀려 30분 잠김(INVITATION_CODE_LOCKED, 본문 lockExpiresAt — 재발송하면 풀림) · 기본 요청 제한',
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Body() dto: AcceptMyInvitationDto,
  ): Promise<AcceptMyInvitationResponseDto> {
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.signups.acceptForAccount(user.id, dto);
  }
}
