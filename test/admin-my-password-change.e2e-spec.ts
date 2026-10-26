import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ADMIN_PASSWORD_MESSAGES } from '../src/auth/admin-password-policy';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const OWN = 'Own-pass-12!';
const NEW = 'New-pass-12!';

// MY PAGE 내 비밀번호 변경(1팀 S-PTWREE)을 실제 DB 로 본다 — 현재 비밀번호 확인이 가장 먼저, 정책 순서,
// 세션은 안 끊김, 이후 로그인은 새 비밀번호로만.
describe('MY PAGE 내 비밀번호 변경 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  let roleGroupId: number;
  const adminIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: '내 비밀번호 변경 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    }));
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminChangeHistory.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  async function signedIn() {
    const admin = await prisma.adminAccount.create({
      data: {
        loginId: `mpw${randomInt(10_000_000, 99_999_999)}`,
        bpCodeId,
        name: '홍길동',
        passwordHash: await hashPassword(OWN),
        roleTypeCode: 'BM',
        roleGroupId,
        joinPathCode: 'SIGNUP',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    });
    adminIds.push(admin.adminAccountId);
    const res = await login(admin.loginId, OWN).expect(200);
    return { admin, ...(res.body as AdminLoginResponseDto) };
  }

  const login = (loginId: string, password: string) =>
    request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ loginId, password });
  const authed = (method: 'get' | 'post', path: string, token: string) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  const change = (token: string, body: object) =>
    authed('post', '/auth/admin/me/password-change', token).send(body);
  const messageOf = (res: { body: unknown }) =>
    (res.body as { message: string }).message;

  it('현재 비밀번호가 틀리면 400이고 새 비밀번호 규칙은 보지 않는다 — 가장 먼저 걸린다', async () => {
    const { admin, accessToken } = await signedIn();

    const res = await change(accessToken, {
      currentPassword: 'wrong-pass',
      newPassword: 'x',
      newPasswordConfirm: 'x',
    });
    expect(res.status).toBe(400);
    expect(messageOf(res)).toBe(ADMIN_PASSWORD_MESSAGES.currentMismatch);

    // 비밀번호는 안 바뀌었다 — 원래 비밀번호로 여전히 로그인된다.
    expect((await login(admin.loginId, OWN)).status).toBe(200);
  });

  it('현재 비밀번호를 맞춘 뒤 정책 위반은 400과 문구 하나이고 아무것도 바꾸지 않는다', async () => {
    const { admin, accessToken } = await signedIn();
    const bad = async (body: object, message: string) => {
      const res = await change(accessToken, {
        currentPassword: OWN,
        ...body,
      });
      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(message);
    };

    await bad(
      { newPassword: 'short', newPasswordConfirm: 'short' },
      ADMIN_PASSWORD_MESSAGES.combination,
    );
    await bad(
      { newPassword: OWN, newPasswordConfirm: OWN },
      ADMIN_PASSWORD_MESSAGES.sameAsCurrent,
    );
    await bad(
      { newPassword: NEW, newPasswordConfirm: NEW + 'x' },
      ADMIN_PASSWORD_MESSAGES.confirmMismatch,
    );

    // 전부 거절됐으니 비밀번호는 그대로 — 원래 비밀번호로 여전히 로그인된다.
    expect((await login(admin.loginId, OWN)).status).toBe(200);
  });

  it('바꾸면 세션은 이어지고, 이력이 남고, 이후 로그인은 새 비밀번호로만 된다', async () => {
    const { admin, accessToken, refreshToken } = await signedIn();

    const res = await change(accessToken, {
      currentPassword: OWN,
      newPassword: NEW,
      newPasswordConfirm: NEW,
    });
    expect(res.status).toBe(204);

    // 같은 접근 토큰이 그대로 쓰인다 — 강제 재로그인이 없다.
    expect((await authed('get', '/stores/options', accessToken)).status).toBe(
      200,
    );
    // 갱신 토큰도 그대로 쓰인다 — 다른 기기 세션도 끊지 않는다는 것의 대리 확인.
    const refreshed = (
      await request(app.getHttpServer())
        .post('/auth/admin/refresh')
        .send({ refreshToken })
        .expect(200)
    ).body as AdminRefreshResponseDto;
    expect(refreshed.accessToken).toBeTruthy();

    expect(
      await prisma.adminChangeHistory.count({
        where: { adminAccountId: admin.adminAccountId, field: '비밀번호' },
      }),
    ).toBe(1);
    const [history] = await prisma.adminChangeHistory.findMany({
      where: { adminAccountId: admin.adminAccountId, field: '비밀번호' },
    });
    expect(history.afterValue).toBe('변경');
    expect(history.beforeValue).toBeNull();

    expect((await login(admin.loginId, OWN)).status).toBe(401);
    expect((await login(admin.loginId, NEW)).status).toBe(200);
  });
});
