import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { readJwtSecret } from './jwt-secret';
import { AUTH_THROTTLERS } from './throttle';

// 로그인 경로는 아직 없다. 견본 로그인(staff · customers)을 지웠고, 관리자 웹 로그인은 1팀
// (admin_accounts), 직원 근무 앱 로그인은 3팀(accounts)이 새로 만든다. 그때 그 컨트롤러와
// 서비스를 여기에 더한다 — 가드 · JWT · 요청 제한은 그대로 쓴다.
@Module({
  imports: [
    // 로그인·갱신은 공개 경로이고 비밀번호 검증이 비싸다. 새 로그인 컨트롤러에
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
  providers: [
    // 전역 가드. 기본이 "인증 필요"이고, 예외는 @Public() 로 표시한다.
    // 반대로 두면 새 컨트롤러를 만들 때마다 보호를 빠뜨릴 수 있다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
