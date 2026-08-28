import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { isProduction } from './config/profile';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 이게 없으면 Nest 가 SIGTERM/SIGINT 리스너를 붙이지 않아
  // PrismaService.onModuleDestroy 가 영영 호출되지 않는다. 컨테이너가 내려갈 때
  // 커넥션이 정리되지 않고 서버 쪽에서 타임아웃될 때까지 남는다.
  app.enableShutdownHooks();

  // 운영에서는 문서를 내보내지 않는다. 스키마 전체가 곧 공격 표면 지도다.
  // 운영에 열어야 한다면 이 조건을 지우기 전에 인증을 먼저 붙일 것.
  if (!isProduction()) {
    const config = new DocumentBuilder()
      .setTitle('Whale ERP API')
      .setDescription('품목과 재고 이동을 다루는 ERP API')
      .setVersion('0.0.1')
      .build();
    SwaggerModule.setup('docs', app, () =>
      SwaggerModule.createDocument(app, config),
    );
  }

  await app.listen(process.env.PORT ?? 8000);
}
void bootstrap();
