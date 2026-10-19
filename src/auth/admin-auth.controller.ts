import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginIdFindService } from './admin-login-id-find.service';
import { AdminLoginInfoService } from './admin-login-info.service';
import { AdminPasswordChangeService } from './admin-password-change.service';
import { AdminTemporaryPasswordService } from './admin-temporary-password.service';
import {
  AllowPasswordChangePending,
  CurrentUser,
  Public,
  UserTypes,
} from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다(TS1272).
import type { AuthUser } from './auth.types';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminLoginIdFindDto } from './dto/admin-login-id-find.dto';
import { AdminLoginIdFindResponseDto } from './dto/admin-login-id-find.response.dto';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from './dto/admin-login.response.dto';
import { AdminLoginInfoResponseDto } from './dto/admin-login-info.response.dto';
import { AdminPasswordChangeDto } from './dto/admin-password-change.dto';
import { AdminSignupSessionDto } from './dto/admin-signup-session.dto';
import { AdminTemporaryPasswordDto } from './dto/admin-temporary-password.dto';
import { AdminTemporaryPasswordResponseDto } from './dto/admin-temporary-password.response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { EMAIL_FIND_IP_LIMIT, REFRESH_IP_LIMIT } from './throttle';

// 관리자 웹(whale-erp-front) 로그인. 직원 앱(/auth/account)과 같은 모양이고, 요청 제한도 같은 두 축이다.
@UseGuards(ThrottlerGuard)
@Controller('auth/admin')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly loginInfo: AdminLoginInfoService,
    private readonly loginIdFind: AdminLoginIdFindService,
    private readonly temporaryPasswords: AdminTemporaryPasswordService,
    private readonly passwordChange: AdminPasswordChangeService,
  ) {}

  /** 관리자 웹 로그인. 잠금 → 아이디 · 비밀번호 → 계정 상태 순으로 판정한다. 잠김 429, 미사용 403. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: AdminLoginDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminLoginResponseDto> {
    return this.auth.login(dto, ip ?? null);
  }

  /**
   * 비밀번호 찾기. 이름 · 아이디 · 이메일이 모두 맞는 사용 중 계정에 임시 비밀번호(1시간)를 메일로 보낸다.
   * 일치 여부 · 메일 발송 여부와 상관없이 같은 202 다(맞는 정보로 1시간 5번을 넘으면 429). 받으면 잠금이 풀리고, 그 비밀번호로 들어오면 강제 변경 대상이다.
   */
  @Public()
  @Post('temporary-passwords')
  @HttpCode(HttpStatus.ACCEPTED)
  issueTemporaryPassword(
    @Body() dto: AdminTemporaryPasswordDto,
  ): Promise<AdminTemporaryPasswordResponseDto> {
    return this.temporaryPasswords.issue(dto);
  }

  /**
   * 아이디 찾기. 이름 · 이메일이 맞는 사용 중 계정의 아이디를 가려서 준다(메일로 보내지 않는다). 맞는 계정이
   * 없거나 미사용 · 탈퇴 · 삭제 계정과만 맞으면 같은 문구의 404 다.
   */
  @ApiNotFoundResponse({
    description: '맞는 사용 중 계정이 없음. 어느 경우든 같은 문구',
  })
  @ApiTooManyRequestsResponse({
    description: '요청 제한(임시) — 같은 IP 1분 30번, 같은 이메일 10분 10번',
  })
  // shortcut: 횟수 제한이 결정 전이라 이메일 찾기와 같은 IP 한도 + 기본 계정 축(본문 이메일)만 건다. 계정 축은 넣은 이메일마다
  // 새 버킷이라 이메일을 바꿔 가며 이름을 맞혀 보는 것은 IP 축만 늦춘다. 정해지면 바꾼다.
  @Throttle({ ip: EMAIL_FIND_IP_LIMIT })
  @Public()
  @Post('login-id-find-attempts')
  @HttpCode(HttpStatus.OK)
  findLoginId(
    @Body() dto: AdminLoginIdFindDto,
  ): Promise<AdminLoginIdFindResponseDto> {
    return this.loginIdFind.find(dto);
  }

  /** 접근 토큰 재발급. 세션은 마지막 사용부터 1시간으로 밀린다. 만료 · 종료 · 미사용 계정이면 401. */
  @Public()
  @Throttle({ ip: REFRESH_IP_LIMIT })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<AdminRefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * 가입 완료 화면의 「웨일ERP 시작하기」. 비밀번호 없이 signupToken(가입 응답, 10분)으로 로그인 접속을
   * 낸다. 토큰이 만료·위조됐거나 그 사이 계정 상태가 바뀌면 401 · 403 — front 는 로그인 화면으로 보낸다.
   */
  @Public()
  @Post('signup-session')
  @HttpCode(HttpStatus.OK)
  signupSession(
    @Body() dto: AdminSignupSessionDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminLoginResponseDto> {
    return this.auth.loginFromSignupToken(
      dto.signupToken,
      dto.deviceInformation,
      ip ?? null,
    );
  }

  /** 이 브라우저의 세션을 종료한다. 다른 브라우저는 그대로다. */
  @ApiBearerAuth()
  @UserTypes('admin')
  @AllowPasswordChangePending()
  @SkipThrottle({ ip: true })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthUser): Promise<void> {
    // @UserTypes('admin') 가 막지만 타입은 그것을 모른다.
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.auth.logout(user.sid);
  }

  /**
   * 화면을 그릴 정보 — 계정 · 메뉴(+권한) · 관리 점포 · 공통코드. 부르는 시점의 값이다. 관리자 웹은 로그인
   * 직후 한 번 받아 쓰고, 바뀐 값은 다시 로그인할 때 받는다. 업무 API 의 판정은 요청마다 현재 값으로 한다.
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @AllowPasswordChangePending()
  // 로그인 경로가 아니라 요청 제한 두 축을 모두 끈다(인증된 조회).
  @SkipThrottle({ ip: true, account: true })
  @Get('login-info')
  getLoginInfo(
    @CurrentUser() user: AuthUser,
  ): Promise<AdminLoginInfoResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.loginInfo.get(user.id);
  }

  /**
   * 강제 비밀번호 변경 — 초기 · 임시 비밀번호로 들어온 계정이 새 비밀번호를 정한다. 현재 비밀번호는 묻지 않는다.
   * 정책 위반은 400 과 정책 문구 하나, 약관이 필요한 계정이 동의하지 않으면 400, 대상이 아니면 409, 로그인에 쓴
   * 비밀번호가 만료됐으면 401. 바꿔도 모든 기기의 로그인은 이어진다. 끝나기 전에는 이 경로 · 로그인 정보 ·
   * 로그아웃 말고는 403 이다.
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @AllowPasswordChangePending()
  @ApiBadRequestResponse({
    description: '비밀번호 정책 위반 · 필수 약관 미동의',
  })
  @ApiConflictResponse({ description: '강제 변경 대상이 아님' })
  @Post('password-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  changeRequiredPassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: AdminPasswordChangeDto,
    @Ip() ip: string | undefined,
  ): Promise<void> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.passwordChange.changeRequired(user.id, dto, ip);
  }
}
