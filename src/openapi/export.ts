import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { createOpenApiDocument } from './document';

/**
 * HTTP 서버를 열지 않고 Swagger 문서를 openapi/openapi.json 으로 쓴다 (`pnpm openapi:export`).
 *
 * init()·listen() 을 부르지 않으므로 PrismaService.onModuleInit($connect)이 돌지 않아
 * DB 없이 돈다. JWT_SECRET 은 필요하다 — AuthModule 이 만들어질 때 길이를 검사한다.
 * MAIL_* 는 비어 있으면 자리 값을 넣는다. MailModule 이 기동 때 요구하지만 문서를 쓰는 동안 메일은 나가지 않는다.
 *
 * Swagger 스키마는 nest build 의 CLI 플러그인이 붙인다. ts-node 로 바로 돌리면 DTO 속성이
 * 문서에서 빠지므로, 반드시 빌드 결과(dist/openapi/export.js)로 실행한다.
 */
async function main(): Promise<void> {
  // AppModule 을 import 할 때 ConfigModule 이 env 파일을 이미 읽었다. 파일에 값이 있으면 그대로 쓴다.
  process.env.MAIL_USERNAME ||= 'openapi-export@invalid';
  process.env.MAIL_PASSWORD ||= 'openapi-export';
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  const doc = createOpenApiDocument(app);
  const out = join(process.cwd(), 'openapi', 'openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  const schemas = Object.keys(doc.components?.schemas ?? {}).length;
  console.log(
    `openapi/openapi.json — 경로 ${Object.keys(doc.paths).length} · 스키마 ${schemas}`,
  );
  await app.close();
}
void main();
