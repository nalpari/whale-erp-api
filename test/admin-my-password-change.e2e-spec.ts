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
    await prisma.temporaryPassword.deleteMany({ where: byAdmin });
    // login() 을 성공·실패 모두 호출해 admin_login_logs 가 쌓인다 — admin_account 보다 먼저 지운다
    // (admin_login_logs_admin_account_id_fkey 는 Restrict, admin-password-change.e2e-spec.ts 와 같은 순서).
    await prisma.adminLoginLog.deleteMany({ where: byAdmin });
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

  it('바꾸면 살아있는 찾기용 임시 비밀번호는 이미 쓴 것까지 모두 무효가 된다 — 강제 비밀번호 변경과 같은 규칙', async () => {
    const { admin, accessToken } = await signedIn();
    const UNUSED = 'Temp-pass-1!';
    const USED = 'Temp-pass-2!';
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    // 아직 쓰지 않은 것과, 이미 한 번 써서 usedAt 이 찍힌 것 — 일반 로그인(admin-auth.service.ts completeSuccess)
    // 은 쓰지 않은 것만 끝내지만, 본인이 비밀번호를 직접 바꾸는 이 경로는 강제 비밀번호 변경과 같이 쓴 것도
    // 끝낸다(남은 시간 동안 로그인해 강제 변경을 다시 켜는 구멍을 막는다).
    const unused = await prisma.temporaryPassword.create({
      data: {
        adminAccountId: admin.adminAccountId,
        passwordHash: await hashPassword(UNUSED),
        expiresAt,
        purpose: 'TEMPORARY',
      },
    });
    const used = await prisma.temporaryPassword.create({
      data: {
        adminAccountId: admin.adminAccountId,
        passwordHash: await hashPassword(USED),
        expiresAt,
        purpose: 'TEMPORARY',
        usedAt: new Date(),
      },
    });

    const res = await change(accessToken, {
      currentPassword: OWN,
      newPassword: NEW,
      newPasswordConfirm: NEW,
    });
    expect(res.status).toBe(204);

    expect((await login(admin.loginId, UNUSED)).status).toBe(401);
    expect((await login(admin.loginId, USED)).status).toBe(401);
    const rows = await prisma.temporaryPassword.findMany({
      where: {
        temporaryPasswordId: {
          in: [unused.temporaryPasswordId, used.temporaryPasswordId],
        },
      },
    });
    expect(rows.every((r) => r.invalidatedAt !== null)).toBe(true);
  });

  it('계정이 지워진 뒤에도 접근 토큰이 살아있으면(세션은 계정 상태를 안 본다) 404 — 비밀번호를 못 바꾼다', async () => {
    const { admin, accessToken } = await signedIn();
    // 플랫폼 관리자가 계정을 지운 상황을 흉내낸다 — admin-session.service.ts findActive 는 계정 상태를
    // 보지 않아 이 세션은 최대 1시간 더 살아있다(코드 리뷰로 찾음, 2026-10-26).
    await prisma.adminAccount.update({
      where: { adminAccountId: admin.adminAccountId },
      data: { isDeleted: true },
    });

    const res = await change(accessToken, {
      currentPassword: OWN,
      newPassword: NEW,
      newPasswordConfirm: NEW,
    });
    expect(res.status).toBe(404);

    // 비밀번호 해시가 그대로다 — 지운 행이 공격자의 새 비밀번호로 바뀌지 않았다.
    const row = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
      select: { passwordHash: true },
    });
    expect(row.passwordHash).toBe(admin.passwordHash);
  });
});
