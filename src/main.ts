import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { isProduction } from './config/profile';
import { applyTrustProxy } from './config/trust-proxy';
import { createOpenApiDocument } from './openapi/document';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 직원 앱은 Next 서버(BFF)를 거쳐 온다. 그 주소를 믿어야 req.ip 가 BFF 가 아니라
  // 사용자의 IP 가 되고, 로그인 요청 제한의 IP 축이 사용자마다 따로 센다.
  // .env.<APP_ENV> 는 AppModule 을 import 할 때(ConfigModule.forRoot) 이미 process.env 에 있다.
  applyTrustProxy(app, process.env.TRUST_PROXY);

  // 이게 없으면 Nest 가 SIGTERM/SIGINT 리스너를 붙이지 않아
  // PrismaService.onModuleDestroy 가 영영 호출되지 않는다. 컨테이너가 내려갈 때
  // 커넥션이 정리되지 않고 서버 쪽에서 타임아웃될 때까지 남는다.
  app.enableShutdownHooks();

  // 운영에서는 문서를 내보내지 않는다. 스키마 전체가 곧 공격 표면 지도다.
  // 운영에 열어야 한다면 이 조건을 지우기 전에 인증을 먼저 붙일 것.
  if (!isProduction()) {
    SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  }

  await app.listen(process.env.PORT ?? 8000);
}
void bootstrap();
