import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminScopeService } from './../src/admin-scope/admin-scope.service';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from './../src/auth-session/auth-session.service';
import { UserType } from './../src/auth/auth.types';
import { PrismaService } from './../src/prisma/prisma.service';

/** GET /stores — 전역 가드가 막는지와 페이지 쿼리 검증. */
describe('점포 선택지 (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const prisma = {
    $transaction: jest.fn((queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
    store: {
      findMany: jest.fn().mockResolvedValue([{ storeId: 11, name: '서초점' }]),
      count: jest.fn().mockResolvedValue(1),
    },
  };
  const scope = {
    getManageableStores: jest.fn().mockResolvedValue({
      roleTypeCode: 'FM',
      stores: [{ storeId: 11, storeTypeCode: 'FRANCHISE' }],
    }),
  };
  const get = (path: string, type?: UserType) => {
    const req = request(app.getHttpServer()).get(path);
    if (!type) return req;
    const token = jwt.sign({
      sub: 1,
      type,
      email: 'a@b.c',
      typ: 'access',
      sid: 1,
    });
    return req.set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      // 직원 앱 토큰은 접속 상태(sid)가 살아 있어야 가드를 지나 종류 검사(403)에 닿는다.
      .overrideProvider(AuthSessionService)
      .useValue({ isActive: jest.fn().mockResolvedValue(true) })
      // 업무 범위는 AdminScopeService 단위 테스트가 본다. 여기서는 점포 11 을 관리하는 가맹 관리자다.
      .overrideProvider(AdminScopeService)
      .useValue(scope)
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('토큰이 없으면 401, 직원 앱 토큰이면 403', async () => {
    await get('/stores').expect(401);
    await get('/stores', 'account').expect(403);
  });

  it('관리자면 { items, total }', async () => {
    const res = await get('/stores?pageSize=200', 'admin').expect(200);
    expect(res.body).toEqual({
      items: [{ storeId: 11, name: '서초점' }],
      total: 1,
    });
  });

  it('사용 중인 관리자 계정이 아니면 403', async () => {
    scope.getManageableStores.mockResolvedValueOnce(null);
    await get('/stores', 'admin').expect(403);
  });

  it('pageSize 가 200 을 넘으면 400', async () => {
    await get('/stores?pageSize=201', 'admin').expect(400);
  });
});
