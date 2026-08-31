import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
// isolatedModules + emitDecoratorMetadata 조합에서 값 import 는 TS1272 로 막힌다.
import type { AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { TokenResponseDto } from './dto/token.response.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** whale-erp-staff 용 로그인. */
  @Public()
  @Post('staff/login')
  @HttpCode(HttpStatus.OK)
  staffLogin(@Body() dto: LoginDto): Promise<TokenResponseDto> {
    return this.auth.login('staff', dto);
  }

  /** whale-erp-front 용 로그인. */
  @Public()
  @Post('customer/login')
  @HttpCode(HttpStatus.OK)
  customerLogin(@Body() dto: LoginDto): Promise<TokenResponseDto> {
    return this.auth.login('customer', dto);
  }

  /**
   * 액세스 토큰 재발급. 리프레시 토큰도 함께 회전하므로 응답의 두 토큰을
   * 모두 갈아 끼워야 한다. 종류(staff/customer)는 토큰 안에 들어 있다.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<TokenResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 저장된 리프레시 토큰을 폐기한다. 액세스 토큰은 만료까지 유효하다. */
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthUser): Promise<void> {
    return this.auth.logout(user);
  }
}
