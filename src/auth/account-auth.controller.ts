import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccountAuthService } from './account-auth.service';
import { CurrentUser, Public, UserTypes } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
// isolatedModules + emitDecoratorMetadata 조합에서 값 import 는 TS1272 로 막힌다.
import type { AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login.response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RefreshResponseDto } from './dto/refresh.response.dto';

// 익명 트래픽으로 갈아 넣을 수 있는 표면이다. 한도를 넘은 요청은 핸들러에 닿기
// 전에 429 로 끊겨 scrypt 를 태우지 못한다.
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
   * 갱신할 때마다 접속 상태의 만료가 지금부터 30일 뒤로 밀린다. 만료되었거나
   * 종료된 접속이면 401 이고, 앱은 로그인 화면으로 보낸다.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<RefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 이 기기의 접속 상태를 종료한다. 다른 기기는 그대로다. */
  @ApiBearerAuth()
  @UserTypes('account')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthUser): Promise<void> {
    // account 토큰은 가드를 통과한 시점에 sid 가 보장된다.
    return this.auth.logout(user.sid!);
  }
}
