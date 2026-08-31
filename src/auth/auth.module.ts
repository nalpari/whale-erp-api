import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { readJwtSecret } from './jwt-secret';
import { AUTH_THROTTLERS } from './throttle';

@Module({
  imports: [
    // 로그인·갱신은 공개 경로이고 비밀번호 검증이 비싸다. 가드는 핸들러보다
    // 먼저 돌므로, 한도를 넘은 요청은 scrypt 에 닿기 전에 429 로 끊긴다.
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
  controllers: [AuthController],
  providers: [
    AuthService,
    // 전역 가드. 기본이 "인증 필요"이고, 예외는 @Public() 로 표시한다.
    // 반대로 두면 새 컨트롤러를 만들 때마다 보호를 빠뜨릴 수 있다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
