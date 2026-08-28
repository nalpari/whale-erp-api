import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // DTO 에 없는 필드는 제거
      forbidNonWhitelisted: true, // 모르는 필드가 오면 400
      transform: true, // 페이로드를 DTO 인스턴스로 변환
    }),
  );

  // 운영에서는 내보내지 않는다. 스키마 전체가 곧 공격 표면 지도다.
  // 운영에서도 필요하면 이 조건을 지우기 전에 인증을 먼저 붙일 것.
  if (process.env.APP_ENV !== 'prod') {
    const config = new DocumentBuilder()
      .setTitle('Whale ERP API')
      .setDescription('품목과 재고 이동을 다루는 ERP API')
      .setVersion('0.0.1')
      .build();
    SwaggerModule.setup('docs', app, () =>
      SwaggerModule.createDocument(app, config),
    );
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
