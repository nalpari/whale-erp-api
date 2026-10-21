import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AccountAuthService } from './account-auth.service';
import { REFRESH_IP_LIMIT } from './throttle';
import { CurrentUser, Public, UserTypes } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
// isolatedModules + emitDecoratorMetadata 조합에서 값 import 는 TS1272 로 막힌다.
import type { AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import {
  LoginAccountResponseDto,
  LoginResponseDto,
} from './dto/login.response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RefreshResponseDto } from './dto/refresh.response.dto';

// 로그인·갱신은 익명 트래픽으로 갈아 넣을 수 있는 표면이다. 한도를 넘은 요청은
// 핸들러에 닿기 전에 429 로 끊겨 scrypt 를 태우지 못한다. 로그아웃은 전역 JWT
// 가드를 먼저 통과한 뒤에 센다.
@UseGuards(ThrottlerGuard)
@Controller('auth/account')
export class AccountAuthController {
  constructor(private readonly auth: AccountAuthService) {}

  /** whale-erp-staff(직원 근무 앱) 로그인. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto);
  }

  /**
   * 액세스 토큰 재발급. 갱신 토큰은 회전하지 않으므로 쓰던 것을 계속 쓴다.
   * 갱신할 때마다 접속 상태의 만료가 지금부터 30일(자동 로그인을 끈 접속은 7일) 뒤로 밀린다. 만료되었거나
   * 종료된 접속이면 401 이고, 앱은 로그인 화면으로 보낸다.
   *
   * 요청 제한: 갱신 토큰마다 10분에 10번, IP 는 1분에 600번(throttle.ts).
   */
  @Public()
  @Throttle({ ip: REFRESH_IP_LIMIT })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<RefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * 로그인한 계정의 지금 정보. 로그인 응답의 account 와 같은 모양이다. 로그인 뒤 관리자가
   * 가입 연결 보류를 풀거나 이메일이 바뀌어도 다시 로그인하지 않고 알 수 있게, 앱이 열릴 때 부른다.
   *
   * 요청 제한을 받지 않는다. 다른 인증된 API 처럼 가드가 접속 상태를 확인하고, scrypt 도 없는
   * 읽기 하나다. 토큰 축(10분 10번)을 그대로 두면 앱을 자주 여는 사용자가 막힌다.
   * 축 이름을 모두 적어야 한다 — 인자 없는 @SkipThrottle() 은 'default' 만 건너뛴다.
   */
  @ApiBearerAuth()
  @UserTypes('account')
  @SkipThrottle({ ip: true, account: true })
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<LoginAccountResponseDto> {
    // @UserTypes('account') 가 막지만 타입은 그것을 모른다.
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.auth.me(user.id);
  }

  /** 이 기기의 접속 상태를 종료한다. 다른 기기는 그대로다. */
  @ApiBearerAuth()
  @UserTypes('account')
  @SkipThrottle({ ip: true })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthUser): Promise<void> {
    // @UserTypes('account') 가 막지만 타입은 그것을 모른다. 종류를 좁혀야 sid 가 있다.
    if (user.type !== 'account') throw new UnauthorizedException();
    return this.auth.logout(user.sid);
  }
}
