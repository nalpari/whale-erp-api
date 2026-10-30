import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { InvitationCheckResponseDto } from './dto/invitation-check.response.dto';
import { InvitationLookupDto } from './dto/invitation-lookup.dto';
import { StaffSignupDto, StaffSignupResponseDto } from './dto/staff-signup.dto';
import { StaffSignupService } from './staff-signup.service';

// 로그인 전 화면이라 공개다. 대입은 같은 번호 5회 · 30분 잠금(서비스, invitation_code_attempts)으로 막는다 — 초대 코드
// 입력에 따로 IP 기준 제한은 두지 않는다(운영 정책 JOI-02 v158, 2026-10-20 재영). 가입이 scrypt 를 태우므로 로그인 같은
// 공개 경로와 같은 AuthModule 기본 요청 제한만 받는다.
@Public()
@UseGuards(ThrottlerGuard)
@Controller('auth/account')
export class StaffSignupController {
  constructor(private readonly signups: StaffSignupService) {}

  /**
   * 초대 확인(WHALEERP-141, 진입 · 가입 화면 가이드 ①·②). 초대 링크의 토큰, 또는 휴대전화번호와 초대 코드 가운데 하나로
   * 살아 있는 가입 초대를 찾아 근무지 · 고용 형태 · 유효 기간 · 화면이 채울 번호를 준다.
   */
  @Post('invitations/check')
  @HttpCode(HttpStatus.OK)
  @ApiBadRequestResponse({
    description: '형식 오류 · 토큰과 번호 · 코드를 함께 보내거나 둘 다 없음',
  })
  @ApiNotFoundResponse({
    description:
      '맞는 초대가 없음(INVITATION_NOT_FOUND — 번호나 코드가 틀림) · 끝난 초대(INVITATION_ENDED — 기한 · 다시 보냄 · 번호 변경 · 퇴직 · 가입 불가)',
  })
  @ApiConflictResponse({
    description:
      '이미 가입을 마친 초대(INVITATION_ALREADY_JOINED) · 그 번호로 계정이 있음(ACCOUNT_EXISTS) — 둘 다 로그인으로',
  })
  @ApiTooManyRequestsResponse({
    description:
      '같은 번호로 번호 + 코드를 5번 틀려 30분 잠김(INVITATION_CODE_LOCKED, 본문 lockExpiresAt — 재발송하면 풀림) · 공개 경로 기본 요청 제한',
  })
  check(@Body() dto: InvitationLookupDto): Promise<InvitationCheckResponseDto> {
    return this.signups.check(dto);
  }

  /**
   * 직원 앱 가입(WHALEERP-601 · 142, 가이드 ③·④). 초대를 다시 확인하고 계정을 만들어 직원 레코드에 잇고(가입 완료) 초대를
   * 수락으로 둔다. 가입을 기다리던 근로계약서는 서명 대기가 된다. 계정 번호는 초대의 번호다. 마치면 로그인 응답과 같은
   * 모양으로 접속 상태를 준다. 가입하는 날 만 19세 미만이면 계정을 만들지 않고 초대를 「가입 불가」로 둔 뒤 400 이다.
   * 본사 제공 동의에 실은 문구 버전(hqSharingConsentVersion)이 지금과 달라도 가입은 마치고 동의만 남기지 않는다 — 응답의
   * hqSharingConsentRecorded 가 false 다(ATT-30 v253).
   */
  @Post('signup')
  @ApiBadRequestResponse({
    description:
      '형식 오류 · 비밀번호 규칙 · 만 19세 미만(SIGNUP_UNDER_AGE, 초대는 가입 불가가 됨)',
  })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND · INVITATION_ENDED — 초대 확인과 같다',
  })
  @ApiConflictResponse({
    description:
      'INVITATION_ALREADY_JOINED · ACCOUNT_EXISTS · 이미 쓰는 이메일(ACCOUNT_EMAIL_TAKEN)',
  })
  @ApiTooManyRequestsResponse({
    description:
      '같은 번호로 번호 + 코드를 5번 틀려 30분 잠김(INVITATION_CODE_LOCKED, 본문 lockExpiresAt — 재발송하면 풀림) · 공개 경로 기본 요청 제한',
  })
  signup(@Body() dto: StaffSignupDto): Promise<StaffSignupResponseDto> {
    return this.signups.signup(dto);
  }
}
