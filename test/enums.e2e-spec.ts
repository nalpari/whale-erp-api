import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EnumCatalogResponseDto } from './../src/enums/dto/enum.response.dto';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * GET /enums 의 HTTP 계약 — 토큰 없이 열리는지, 없는 이름의 404, 캐시 재검증(ETag · 304).
 * 유닛 테스트는 @Public 메타데이터만 본다. 전역 가드가 실제로 비켜 가는지는 여기서만 잡힌다.
 */
describe('enum 조회 (e2e)', () => {
  let app: INestApplication<App>;

  const get = async (path: string, status: number) => {
    const res = await request(app.getHttpServer()).get(path).expect(status);
    return res.body as EnumCatalogResponseDto;
  };

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = fixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('토큰 없이 전체 목록을 받는다', async () => {
    const body = await get('/enums', 200);
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.enums.ContractStatus[0]).toEqual({
      value: 'PENDING_SEND',
      label: '발송 대기',
      order: 1,
    });
    expect(body.enums.WorkType).toBeDefined();
  });

  it('하나만 받으면 같은 version 과 그 enum 만 온다', async () => {
    const all = await get('/enums', 200);
    const one = await get('/enums/WorkType', 200);
    expect(one.version).toBe(all.version);
    expect(Object.keys(one.enums)).toEqual(['WorkType']);
  });

  it('없는 이름이면 404', async () => {
    await request(app.getHttpServer()).get('/enums/Nope').expect(404);
  });

  // 클라이언트가 가진 것이 그대로면 본문을 다시 보내지 않는다.
  it('ETag 를 주고, 같은 ETag 로 다시 물으면 304', async () => {
    const first = await request(app.getHttpServer()).get('/enums').expect(200);
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^W\/"/);
    await request(app.getHttpServer())
      .get('/enums')
      .set('If-None-Match', etag)
      .expect(304);
  });
});
