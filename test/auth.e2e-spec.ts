import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { hashPassword } from './../src/auth/password';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * 전역 가드 배선을 HTTP 계약으로 고정한다. 유닛 테스트는 가드를 직접
 * 생성해 부르므로, APP_GUARD 등록 한 줄을 지워도 전부 통과한다. 그 줄이
 * 사라지면 앱 전체가 인증 없이 열리는데, 여기서만 잡힌다.
 *
 * DB 는 붙이지 않는다. 검증 대상은 라우팅·가드·데코레이터의 조합이지
 * 질의가 아니다. PrismaService 만 갈아 끼우고 나머지는 운영과 같은 것을 쓴다.
 */
describe('인증 (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let prisma: {
    staff: { findUnique: jest.Mock; updateMany: jest.Mock };
    customer: { findUnique: jest.Mock; updateMany: jest.Mock };
    item: { findMany: jest.Mock };
    stockMovement: { groupBy: jest.Mock };
  };

  const token = (payload: Record<string, unknown>) =>
    jwt.sign({ sub: 1, email: 'staff@whale.test', ...payload });

  const staffToken = () => token({ type: 'staff', typ: 'access' });
  const customerToken = () => token({ type: 'customer', typ: 'access' });

  beforeAll(async () => {
    const table = () => ({
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    prisma = {
      staff: table(),
      customer: table(),
      item: { findMany: jest.fn().mockResolvedValue([]) },
      stockMovement: { groupBy: jest.fn().mockResolvedValue([]) },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('토큰 없이', () => {
    it('보호된 경로는 401 이다', async () => {
      await request(app.getHttpServer()).get('/items').expect(401);
    });

    it('@Public 경로는 열려 있다', async () => {
      await request(app.getHttpServer()).get('/').expect(200);
      // 자격 증명이 틀려 401 이지만, 가드가 아니라 핸들러가 낸 401 이다.
      await request(app.getHttpServer())
        .post('/auth/staff/login')
        .send({ email: 'nobody@whale.test', password: 'pw12345!' })
        .expect(401)
        .expect(({ body }: { body: { message: string } }) => {
          expect(body.message).toBe('이메일 또는 비밀번호가 올바르지 않습니다');
        });
    });
  });

  describe('토큰을 들고', () => {
    it('직원 토큰은 품목 API 를 통과한다', async () => {
      await request(app.getHttpServer())
        .get('/items')
        .set('Authorization', `Bearer ${staffToken()}`)
        .expect(200);
    });

    it('고객 토큰은 품목 API 에서 403 이다', async () => {
      await request(app.getHttpServer())
        .get('/items')
        .set('Authorization', `Bearer ${customerToken()}`)
        .expect(403);
    });

    it('리프레시 토큰으로는 API 를 호출할 수 없다', async () => {
      await request(app.getHttpServer())
        .get('/items')
        .set(
          'Authorization',
          `Bearer ${token({ type: 'staff', typ: 'refresh' })}`,
        )
        .expect(401);
    });

    it('다른 키로 서명된 토큰은 거절한다', async () => {
      const forged = new JwtService({ secret: 'x'.repeat(32) }).sign({
        sub: 1,
        type: 'staff',
        email: 'staff@whale.test',
        typ: 'access',
      });
      await request(app.getHttpServer())
        .get('/items')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  it('로그인은 토큰 쌍과 사용자를 돌려준다', async () => {
    prisma.staff.findUnique.mockResolvedValue({
      id: 1,
      email: 'staff@whale.test',
      name: '김직원',
      passwordHash: await hashPassword('pw12345!', { N: 1024, r: 8, p: 1 }),
      refreshTokenHash: null,
    });

    const response = await request(app.getHttpServer())
      .post('/auth/staff/login')
      .send({ email: 'staff@whale.test', password: 'pw12345!' })
      .expect(200);
    const body = response.body as { accessToken: string; user: unknown };

    expect(body).toMatchObject({
      user: { id: 1, email: 'staff@whale.test', type: 'staff' },
    });
    // 발급된 액세스 토큰이 실제로 가드를 통과하는지까지 확인한다.
    await request(app.getHttpServer())
      .get('/items')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
  });
});
