import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyTrustProxy } from '../src/config/trust-proxy';
import { PrismaService } from '../src/prisma/prisma.service';

// 요청 제한이 실제 경로에 걸려 있는지 본다. 축의 키 계산은 throttle.spec 이 다룬다.
// 제한은 프로세스 메모리에 쌓이므로 앱을 테스트마다 새로 띄운다.
describe('인증 경로 요청 제한 (e2e)', () => {
  let app: INestApplication<App> & NestExpressApplication;
  const attemptedEmails: string[] = [];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<
      INestApplication<App> & NestExpressApplication
    >();
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

  it('갱신의 IP 한도는 1분에 600번이다 — 프록시 뒤 공유 IP 에서도 서로 막지 않을 만큼 넉넉하고, 무작위 토큰을 무한히 보낼 수는 없다', async () => {
    const statuses = await statusesOf(601, () =>
      post('/auth/account/refresh', { refreshToken: randomUUID() }),
    );

    expect(statuses.slice(0, 600)).toEqual(Array<number>(600).fill(401));
    expect(statuses[600]).toBe(429);
  }, 60_000);

  it('같은 갱신 토큰은 10분에 10번까지다', async () => {
    const token = randomUUID();
    const statuses = await statusesOf(11, () =>
      post('/auth/account/refresh', { refreshToken: token }),
    );

    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
  });

  // 이메일을 매번 바꿔 계정 축에 걸리지 않게 하고 IP 축만 센다.
  const loginAsNewEmail = (forwardedFor?: string) => {
    const email = `${randomUUID()}@test.invalid`;
    attemptedEmails.push(email);
    const req = post('/auth/account/login', { email, password: 'wrong-pw' });
    return forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req;
  };

  it('로그인은 한 IP 에서 1분에 60번까지다 — 매장 와이파이 하나에서 출근 때 몰려도 견디게', async () => {
    const statuses = await statusesOf(61, () => loginAsNewEmail());

    expect(statuses).toEqual([...Array<number>(60).fill(401), 429]);
  }, 30_000);

  it('TRUST_PROXY 가 비어 있으면 X-Forwarded-For 를 무시한다 — 헤더를 바꿔 가며 IP 축을 피할 수 없다', async () => {
    applyTrustProxy(app, '');

    const statuses = await statusesOf(61, (i) =>
      loginAsNewEmail(`203.0.113.${i + 1}`),
    );

    expect(statuses).toEqual([...Array<number>(60).fill(401), 429]);
  }, 30_000);

  it('믿는 프록시 뒤에서는 X-Forwarded-For 의 클라이언트 IP 마다 따로 센다', async () => {
    // supertest 는 loopback(IPv4-mapped 로 보일 수도 있다)에서 접속하므로 loopback 이 곧 BFF 다.
    applyTrustProxy(app, 'loopback');

    const first = await statusesOf(61, () => loginAsNewEmail('203.0.113.1'));
    const other = await loginAsNewEmail('203.0.113.2');
    // 클라이언트가 앞에 지어 넣은 값은 건너뛴다. 프록시가 덧붙인 맨 오른쪽이 IP 다.
    const spoofed = await loginAsNewEmail('198.51.100.9, 203.0.113.1');

    expect(first).toEqual([...Array<number>(60).fill(401), 429]);
    expect(other.status).toBe(401);
    expect(spoofed.status).toBe(429);
  }, 30_000);

  it('믿는 프록시가 X-Forwarded-For 를 붙이지 않으면 프록시 주소 하나로 센다 — BFF 가 헤더를 넣어야 하는 이유', async () => {
    applyTrustProxy(app, 'loopback');

    const bare = await statusesOf(61, () => loginAsNewEmail());
    const forwarded = await loginAsNewEmail('203.0.113.7');

    expect(bare).toEqual([...Array<number>(60).fill(401), 429]);
    expect(forwarded.status).toBe(401);
  }, 30_000);

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
