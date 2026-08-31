import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ItemsModule } from './items/items.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // APP_ENV 는 파일이 아니라 실행 환경에서 온다. 파일 안에 두면
    // 어느 파일을 읽을지 정하는 값을 그 파일에서 읽어야 하므로 순환이다.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.APP_ENV ?? 'local'}`,
    }),
    PrismaModule,
    AuthModule,
    ItemsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      // main.ts 의 useGlobalPipes 대신 DI 로 등록한다. 그래야 테스트가
      // 만드는 앱에도 같은 파이프가 붙어, e2e 가 운영과 다른 검증을
      // 통과시키는 일이 없다.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // DTO 에 없는 필드는 제거
        forbidNonWhitelisted: true, // 모르는 필드가 오면 400
        transform: true, // 페이로드를 DTO 인스턴스로 변환
      }),
    },
  ],
})
export class AppModule {}
