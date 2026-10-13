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
import { ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginInfoService } from './admin-login-info.service';
import { AdminTemporaryPasswordService } from './admin-temporary-password.service';
import { CurrentUser, Public, UserTypes } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다(TS1272).
import type { AuthUser } from './auth.types';
import { AdminLoginDto } from './dto/admin-login.dto';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from './dto/admin-login.response.dto';
import { AdminLoginInfoResponseDto } from './dto/admin-login-info.response.dto';
import { AdminTemporaryPasswordDto } from './dto/admin-temporary-password.dto';
import { RefreshDto } from './dto/refresh.dto';
import { REFRESH_IP_LIMIT } from './throttle';

// 관리자 웹(whale-erp-front) 로그인. 직원 앱(/auth/account)과 같은 모양이고, 요청 제한도 같은 두 축이다.
@UseGuards(ThrottlerGuard)
@Controller('auth/admin')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly loginInfo: AdminLoginInfoService,
    private readonly temporaryPasswords: AdminTemporaryPasswordService,
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
   * 일치 여부와 상관없이 같은 202 다. 받으면 잠금이 풀리고, 그 비밀번호로 들어오면 강제 변경 대상이다.
   */
  @Public()
  @Post('temporary-passwords')
  @HttpCode(HttpStatus.ACCEPTED)
  issueTemporaryPassword(
    @Body() dto: AdminTemporaryPasswordDto,
  ): Promise<{ message: string }> {
    return this.temporaryPasswords.issue(dto);
  }

  /** 접근 토큰 재발급. 세션은 마지막 사용부터 1시간으로 밀린다. 만료 · 종료 · 미사용 계정이면 401. */
  @Public()
  @Throttle({ ip: REFRESH_IP_LIMIT })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<AdminRefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 이 브라우저의 세션을 종료한다. 다른 브라우저는 그대로다. */
  @ApiBearerAuth()
  @UserTypes('admin')
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
  // 로그인 경로가 아니라 요청 제한 두 축을 모두 끈다(인증된 조회).
  @SkipThrottle({ ip: true, account: true })
  @Get('login-info')
  getLoginInfo(
    @CurrentUser() user: AuthUser,
  ): Promise<AdminLoginInfoResponseDto> {
    if (user.type !== 'admin') throw new UnauthorizedException();
    return this.loginInfo.get(user.id);
  }
}
