import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthSessionModule } from '../auth-session/auth-session.module';
import { AccountAuthController } from './account-auth.controller';
import { AccountAuthService } from './account-auth.service';
import { NoopPasswordResetPinSender } from './noop-password-reset-pin.sender';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetPinSender } from './password-reset-pin-sender';
import { PasswordResetService } from './password-reset.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { readJwtSecret } from './jwt-secret';
import { dummyPasswordHash } from './password';
import { AUTH_THROTTLERS } from './throttle';

// 직원 근무 앱 로그인(3팀 accounts)만 있다. 관리자 웹 로그인은 1팀(admin_accounts)이
// 새로 만들 때 컨트롤러와 서비스를 여기에 더한다 — 가드 · JWT · 요청 제한은 그대로 쓴다.
@Module({
  imports: [
    AuthSessionModule,
    // 로그인·갱신은 공개 경로이고 비밀번호 검증이 비싸다. 로그인 컨트롤러에
    // @UseGuards(ThrottlerGuard) 를 걸면 한도를 넘은 요청은 scrypt 에 닿기 전에 429 로 끊긴다.
    ThrottlerModule.forRoot(AUTH_THROTTLERS),
    JwtModule.registerAsync({
      inject: [ConfigService],
      // 기본값을 두지 않는다. 비어 있거나 짧으면 여기서 던져 기동을 멈춘다.
      // 조용히 도는 것보다 못 뜨는 편이 낫다.
      useFactory: (config: ConfigService) => ({
        secret: readJwtSecret(config.get<string>('JWT_SECRET')),
      }),
    }),
  ],
  controllers: [AccountAuthController, PasswordResetController],
  providers: [
    AccountAuthService,
    PasswordResetService,
    // 메일 발송 기반(WHALEERP-320)이 생기면 이 자리를 그 구현으로 바꾼다.
    { provide: PasswordResetPinSender, useClass: NoopPasswordResetPinSender },
    // 전역 가드. 기본이 "인증 필요"이고, 예외는 @Public() 로 표시한다.
    // 반대로 두면 새 컨트롤러를 만들 때마다 보호를 빠뜨릴 수 있다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule implements OnModuleInit {
  /**
   * 없는 계정의 비밀번호·핀 대조에 쓰는 더미 해시를 기동 때 계산한다. 첫 요청에서 계산하면 그
   * 요청만 scrypt 를 두 번 돌아, 인스턴스마다 한 번 가입 여부가 시간으로 드러난다. 실패하면
   * 기동이 멈춘다 — 요청 중에 실패해 없는 계정만 500 이 되는 것보다 낫다.
   */
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash();
  }
}
