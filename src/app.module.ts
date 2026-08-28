import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
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
    ItemsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
