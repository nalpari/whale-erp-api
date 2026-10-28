import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import { signedInUserTracker } from '../auth/throttle';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  AcceptMyInvitationDto,
  AcceptMyInvitationResponseDto,
  MyInvitationListResponseDto,
} from './dto/my-invitation.dto';
import { InvitationIdPipe } from './invitation-id.pipe';
import { StaffSignupService } from './staff-signup.service';

// 로그인 뒤 내게 온 다른 근무지의 가입 초대를 골라 그 근무지를 더한다(WHALEERP-603, 2026-10-28 — 초대 코드 · 링크 입력 대신
// 목록). 따로 IP 제한은 두지 않는다(운영 정책 JOI-02 v158, 2026-10-20 재영) — AuthModule 기본 요청 제한과 아래 계정 축만 받는다.
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@ApiTooManyRequestsResponse({ description: '계정 · IP 요청 한도' })
@UseGuards(ThrottlerGuard)
// 계정 축은 접근 토큰이 아니라 계정으로 센다 — 토큰은 15분마다 바뀌어 새 버킷이 된다(api #82 리뷰). 한도는 기본값 그대로
@Throttle({
  account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
})
@UserTypes('account')
@Controller('me/invitations')
export class MyInvitationsController {
  constructor(private readonly signups: StaffSignupService) {}

  /**
   * 내게 온 가입 초대 — 계정의 휴대전화번호로 나간, 아직 쓸 수 있는 가입 초대 · 재초대(보냄 · 기한 안 · 아직 계정 없는
   * 직원 레코드). 보낸 시각 최근 순. 근무지 · 고용 형태 · 직무 · 유효 기간과 본사 제공 동의를 물을지(직영이 아니고 계정이
   * 아직 동의하지 않았을 때) 준다.
   */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<MyInvitationListResponseDto> {
    // @UserTypes('account') 가 막지만 타입은 그것을 모른다.
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.signups.listForAccount(user.id);
  }

  /**
   * 근무지 더하기 — 목록에서 고른 초대를 다시 확인하고 그 근무지의 직원 레코드를 이 계정에 잇는다(가입 완료 · 초대 수락).
   * 가입을 기다리던 근로계약서는 서명 대기가 된다.
   */
  @Post(':invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({ description: '형식 오류' })
  @ApiNotFoundResponse({
    description:
      'INVITATION_NOT_FOUND — 없는 초대 · 범위 밖 id · 가입 초대가 아님 · 남의 번호로 온 초대(그 초대의 상태와 상관없이 같다) · INVITATION_ENDED — 내 초대가 끝남(기한 · 다시 보냄 · 번호 변경 · 퇴직 · 가입 불가)',
  })
  @ApiConflictResponse({
    description:
      'INVITATION_ALREADY_JOINED — 내 초대를 먼저 더했거나 같은 초대로 동시에',
  })
  accept(
    @Param('invitationId', InvitationIdPipe) invitationId: number,
    @CurrentUser() user: AuthUser,
    @Body() dto: AcceptMyInvitationDto,
  ): Promise<AcceptMyInvitationResponseDto> {
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.signups.acceptForAccount(user.id, invitationId, dto);
  }
}
