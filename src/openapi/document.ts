import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Swagger 문서를 만드는 한 곳. 개발 서버의 /docs-json 과 `pnpm openapi:export` 가
 * 같은 함수를 써야 커밋된 openapi/openapi.json 이 서버 문서와 같다.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Whale ERP API')
    .setDescription('품목과 재고 이동을 다루는 ERP API')
    .setVersion('0.0.1')
    // 전역으로 걸지 않는다. 전역 요구를 두면 로그인·갱신처럼 토큰을
    // 발급하는 @Public() 라우트까지 "토큰이 필요하다"고 표시되어,
    // 생성된 클라이언트가 로그인에 Authorization 헤더를 붙인다.
    // 보호되는 컨트롤러에 @ApiBearerAuth() 를 붙여 표시한다.
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}
