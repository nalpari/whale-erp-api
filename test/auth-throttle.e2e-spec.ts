import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// 요청 제한이 실제 경로에 걸려 있는지 본다. 축의 키 계산은 throttle.spec 이 다룬다.
// 제한은 프로세스 메모리에 쌓이므로 앱을 테스트마다 새로 띄운다.
describe('인증 경로 요청 제한 (e2e)', () => {
  let app: INestApplication<App>;
  const attemptedEmails: string[] = [];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app
      .get(PrismaService)
      .loginHistory.deleteMany({ where: { email: { in: attemptedEmails } } });
    await app.close();
  });

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).send(body);

  const statusesOf = async (n: number, send: (i: number) => request.Test) => {
    const statuses: number[] = [];
    // 순서대로 보낸다. 동시에 보내면 어느 것이 한도를 넘는지 정해지지 않는다.
    for (let i = 0; i < n; i++) statuses.push((await send(i)).status);
    return statuses;
  };

  it('갱신은 IP 축에서 빠진다 — 한 IP 에서 서로 다른 토큰 31개가 와도 429 가 아니다', async () => {
    const statuses = await statusesOf(31, () =>
      post('/auth/account/refresh', { refreshToken: randomUUID() }),
    );

    expect(statuses).toEqual(Array(31).fill(401));
  });

  it('같은 갱신 토큰은 10분에 10번까지다', async () => {
    const token = randomUUID();
    const statuses = await statusesOf(11, () =>
      post('/auth/account/refresh', { refreshToken: token }),
    );

    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
  });

  it('로그인은 한 IP 에서 1분에 30번까지다', async () => {
    const statuses = await statusesOf(31, () => {
      const email = `${randomUUID()}@test.invalid`;
      attemptedEmails.push(email);
      return post('/auth/account/login', { email, password: 'wrong-pw' });
    });

    expect(statuses).toEqual([...Array<number>(30).fill(401), 429]);
  });

  it('핀 확인은 같은 이메일로 10분에 10번까지다', async () => {
    const email = `${randomUUID()}@test.invalid`;
    const statuses = await statusesOf(11, () =>
      post('/auth/account/password-reset-pins/verify', {
        email,
        pin: 'AB12CD',
      }),
    );

    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
  });
});
