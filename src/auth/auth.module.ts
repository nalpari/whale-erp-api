import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        // 기본값을 두지 않는다. 시크릿이 빠진 채로 뜨면 아무나 서명할 수
        // 있는 토큰을 발급하게 되므로, 조용히 도는 것보다 못 뜨는 편이 낫다.
        if (!secret)
          throw new Error(
            'JWT_SECRET 이 설정되지 않았습니다. .env.<APP_ENV> 를 확인하세요.',
          );
        return { secret };
      },
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
