import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginIdFindService } from './admin-login-id-find.service';
import { AdminLoginInfoService } from './admin-login-info.service';
import { AdminPasswordChangeService } from './admin-password-change.service';
import { AdminProfileService } from './admin-profile.service';
import { AdminTemporaryPasswordService } from './admin-temporary-password.service';
import { BpProfileService } from './bp-profile.service';
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
import { AdminProfileEmailAvailabilityQueryDto } from './dto/admin-profile-email-availability-query.dto';
import { AdminProfileEmailAvailabilityResponseDto } from './dto/admin-profile-email-availability.response.dto';
import { AdminProfileUpdateDto } from './dto/admin-profile-update.dto';
import { AdminProfileResponseDto } from './dto/admin-profile.response.dto';
import { AdminSignupSessionDto } from './dto/admin-signup-session.dto';
import { AdminTemporaryPasswordDto } from './dto/admin-temporary-password.dto';
import { AdminTemporaryPasswordResponseDto } from './dto/admin-temporary-password.response.dto';
import { BpBusinessVerificationDto } from './dto/bp-business-verification.dto';
import { BpBusinessVerificationResponseDto } from './dto/bp-business-verification.response.dto';
import { BpProfileUpdateDto } from './dto/bp-profile-update.dto';
import { BpProfileResponseDto } from './dto/bp-profile.response.dto';
import { RefreshDto } from './dto/refresh.dto';
import {
  EMAIL_FIND_IP_LIMIT,
  REFRESH_IP_LIMIT,
  signedInUserTracker,
} from './throttle';

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
    private readonly bpProfile: BpProfileService,
    private readonly profile: AdminProfileService,
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
   * 받으면 잠금이 풀리고, 그 비밀번호로 들어오면 강제 변경 대상이다.
   */
  @ApiNotFoundResponse({
    description:
      '맞는 사용 중 계정이 없음. 미사용 · 탈퇴 · 삭제와만 맞아도 아이디 찾기와 같은 문구',
  })
  @ApiTooManyRequestsResponse({
    description:
      '같은 계정 1시간 5번(한글 문구) 또는 요청 제한 — 같은 IP 1분 30번, 같은 이메일 10분 10번',
  })
  @ApiBadRequestResponse({
    description:
      '이름 · 아이디가 비었거나 20자를 넘음 · 이메일 형식이 아니거나 254자를 넘음 · 모르는 칸이 있음',
  })
  @ApiServiceUnavailableResponse({
    description:
      'SMTP 로 메일을 보내지 못함 · 메일 설정 없음. `code: TEMPORARY_PASSWORD_SEND_FAILED`, 임시 비밀번호는 저장하지 않는다. 템플릿이 꺼진 것처럼 다시 시도해도 풀리지 않는 실패는 500',
  })
  // 404 · 503 으로 일치 여부가 드러나게 되어(front 요청, 2026-10-20) 아이디 찾기와 같은 IP 한도로 낮춘다.
  @Throttle({ ip: EMAIL_FIND_IP_LIMIT })
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
  @ApiBadRequestResponse({
    description:
      '이름이 비었거나 20자를 넘음 · 이메일 형식이 아니거나 254자를 넘음 · 모르는 칸이 있음',
  })
  @ApiNotFoundResponse({
    description: '맞는 사용 중 계정이 없음. 어느 경우든 같은 문구',
  })
  @ApiTooManyRequestsResponse({
    description: '요청 제한 — 같은 IP 1분 30번, 같은 이메일 10분 10번',
  })
  // 횟수 제한은 IP 1분 30번 + 기본 계정 축(본문 이메일, 10분 10번), 연속 실패 잠금은 없다(WHALEERP-398, 2026-10-20).
  // 계정 축은 넣은 이메일마다 새 버킷이라, 이메일을 바꿔 가며 이름을 맞혀 보는 것은 IP 축만 늦춘다.
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

  /**
   * MY PAGE 내 정보 (S-JXKHCM). 플랫폼 · BP 여섯 역할 모두 쓴다. AllowPasswordChangePending 을
   * 달지 않는다 — 강제 비밀번호 변경 대상이면 이 경로도 403 이다(위 changeRequiredPassword 주석과 같다).
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @SkipThrottle({ ip: true, account: true })
  @Get('me')
  getProfile(@CurrentUser() user: AuthUser): Promise<AdminProfileResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.profile.get(user.id);
  }

  /**
   * 내 기본정보 저장 — 이름 · 연락처 · 이메일만. 이메일을 바꾸면 지금 비밀번호(currentPassword)도
   * 받아 맞는지 본다(틀리거나 없으면 400) — 탈취한 접근 토큰만으로 로그인 이메일을 공격자 주소로
   * 바꿔 비밀번호 찾기를 가로채는 계정 탈취를 막는다(ip-code-review-claude 적대적 리뷰로 찾음,
   * 2026-10-21). 이메일이 다른 관리자 계정과 겹치면 409.
   * 계정 축 기본 추적은 본문의 email 로 센다(throttle.ts accountTracker) — 저장할 새 이메일을
   * 호출자가 그대로 고를 수 있어, 매번 다른 값을 보내면 버킷을 계속 새로 만들어 계정 한도를
   * 비울 수 있었다(코드 리뷰로 찾음, 2026-10-21). my-profile.controller.ts 의 비밀번호 · 이메일
   * 변경과 같이 signedInUserTracker 로 로그인한 계정 자신으로 고정한다.
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @ApiBadRequestResponse({
    description:
      '형식 위반 · 동시 수정 토큰 형식 오류 · 이메일 변경 시 지금 비밀번호 틀림(없음 포함)',
  })
  @ApiConflictResponse({
    description: '이미 등록된 이메일 · 동시 수정(다른 관리자가 먼저 저장)',
  })
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @Patch('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: AdminProfileUpdateDto,
  ): Promise<void> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.profile.update(user.id, dto);
  }

  /**
   * 이메일 중복 확인 — 칸을 벗어나거나 Enter 를 칠 때 부른다. 원래 이메일 그대로면 화면이 부르지 않는다.
   * 중복 확인 경로는 한도를 끄지 않는다 — 가입(admin-signup)의 같은 종류 경로도 기본 한도를 그대로
   * 쓰기로 정했다(api #37 머지, 2026-10-15). SkipThrottle 을 달았던 것을 걷는다(코드 리뷰로 찾음,
   * 2026-10-21) — 이 경로는 다른 관리자 계정의 이메일 등록 여부를 그대로 알려줘 한도까지 꺼두면
   * 플랫폼 전체를 대상으로 쓸어볼 수 있다. GET 이라 본문이 없어 기본 계정 축(AUTH_THROTTLERS)은
   * Bearer 토큰으로 센다(10분 10건, 토큰은 15분마다 바뀌어 매번 새 버킷) — IP 축(분당 60건)만
   * 걸린다던 주석은 틀렸었다(코드 리뷰로 찾음). 정상 사용자가 10분 안에 11번 넘게 고쳐 볼 일은
   * 드물다고 보고 지금은 그대로 둔다.
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @Get('me/email-availability')
  async checkProfileEmail(
    @CurrentUser() user: AuthUser,
    @Query() query: AdminProfileEmailAvailabilityQueryDto,
  ): Promise<AdminProfileEmailAvailabilityResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return {
      available: await this.profile.checkEmailAvailable(user.id, query.email),
    };
  }

  /** 내 BP 사업자정보(MY PAGE, S-UOJVUR). BP 마스터만 받는다 — 그 밖의 권한은 403, 계정이 지워졌으면
   * 404. GET me 와 같이 인증된 조회라 한도를 끈다(코드 리뷰로 찾음, 2026-10-22 — 탭 전환·저장 뒤
   * 재조회가 로그인성 한도에 걸릴 수 있었다). */
  @ApiBearerAuth()
  @UserTypes('admin')
  @ApiForbiddenResponse({ description: 'BP 마스터가 아님' })
  @ApiNotFoundResponse({ description: '관리자 계정을 찾을 수 없음' })
  @SkipThrottle({ ip: true, account: true })
  @Get('me/bp')
  getBpProfile(@CurrentUser() user: AuthUser): Promise<BpProfileResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.bpProfile.get(user.id);
  }

  /**
   * 바로 고칠 수 있는 항목 저장(상호명 · 대표자 연락처 · 대표자 이메일 · 사업장주소 · 업태 · 종목).
   * 사업자등록번호 · 대표자명 · 개업일자는 여기 보내지 않는다 — business-verification 이 돌려준
   * businessVerificationToken 을 이 PATCH 에 실어야 그 세 값이 바뀐다(검사와 저장이 나뉜 두 단계).
   * 계정 축은 PATCH me 와 같이 signedInUserTracker 로 로그인한 계정 자신으로 고정한다(코드 리뷰로
   * 찾음, 2026-10-22).
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @ApiForbiddenResponse({ description: 'BP 마스터가 아님' })
  @ApiNotFoundResponse({ description: '관리자 계정을 찾을 수 없음' })
  @ApiConflictResponse({ description: '동시 수정 — updatedAt 이 최신이 아님' })
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @Patch('me/bp')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateBpProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: BpProfileUpdateDto,
  ): Promise<void> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.bpProfile.update(user.id, dto);
  }

  /**
   * 사업자 번호 인증 — 검사만(최초 · 재인증 공통). 다른 BP · 점포가 쓰는 번호면 409, 국세청과 다르면 422,
   * 국세청 연동 장애면 503. 저장은 하지 않는다 — 받은 토큰을 PATCH /me/bp 의 businessVerificationToken 으로
   * 보내야 사업자등록번호 · 대표자명 · 개업일자 · 인증일시가 반영된다(점포 사업자정보와 같은 패턴, 2026-10-22).
   * IP · 계정마다 시간당 10건 — 점포 사업자정보 인증(stores.controller.ts)과 같은 기준이다. 국세청을 실제로
   * 부르는 횟수는 BpProfileService 가 관리자별로 따로 센다(countNtsCall, StoreManagementService 와 같은
   * 방식) — 국세청 키 · 하루 할당량을 모든 BP 가 함께 쓰므로, 한 관리자가 반복해 부르면 그날 모든 BP 의
   * 가입 · 점포 · MY PAGE 인증이 503 이 된다(코드 리뷰로 찾음, 2026-10-22 — 점포 쪽에만 있던 보호가
   * 빠져 있었다).
   */
  @ApiBearerAuth()
  @UserTypes('admin')
  @ApiForbiddenResponse({ description: 'BP 마스터가 아님' })
  @ApiConflictResponse({ description: '다른 BP · 점포가 쓰는 사업자등록번호' })
  @ApiUnprocessableEntityResponse({ description: '국세청 정보와 불일치' })
  @ApiServiceUnavailableResponse({ description: '국세청 연동 장애' })
  @Throttle({
    ip: { limit: 10, ttl: 3_600_000 },
    account: { limit: 10, ttl: 3_600_000, getTracker: signedInUserTracker },
  })
  @ApiTooManyRequestsResponse({ description: 'IP · 계정의 시간당 한도(10건)' })
  @Post('me/bp/business-verification')
  @HttpCode(HttpStatus.OK)
  requestBpBusinessVerification(
    @CurrentUser() user: AuthUser,
    @Body() dto: BpBusinessVerificationDto,
  ): Promise<BpBusinessVerificationResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.bpProfile.requestVerification(user.id, dto);
  }
}
