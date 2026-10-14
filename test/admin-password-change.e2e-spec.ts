import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  RELOGIN_REQUIRED_MESSAGE,
  TERMS_REQUIRED_MESSAGE,
} from '../src/auth/admin-password-change.service';
import { ADMIN_PASSWORD_MESSAGES } from '../src/auth/admin-password-policy';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from '../src/auth/dto/admin-login.response.dto';
import { AdminLoginInfoResponseDto } from '../src/auth/dto/admin-login-info.response.dto';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '../src/auth/access-messages';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const TEMP = 'Temp-pass-12';
const NEW = 'New-pass-12!';
const MIN = 60_000;

// 강제 비밀번호 변경(1팀 S-VFGQLI)을 실제 DB 로 본다 — 변경 전 API 차단, 약관과 한 트랜잭션, 임시 비밀번호 만료,
// 세션 유지. 시스템이 만든 계정(플랫폼등록, 비밀번호 '!')이 초기 비밀번호로 처음 들어온 경우다.
describe('관리자 강제 비밀번호 변경 (e2e, DB)', () => {
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
        tradeName: '강제 변경 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    }));
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.termsAgreementLog.deleteMany({ where: byAdmin });
    await prisma.adminChangeHistory.deleteMany({ where: byAdmin });
    await prisma.adminLoginLog.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.temporaryPassword.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  /** 시스템이 만든 계정 — 초기 비밀번호(20분 남음)로 로그인한 토큰까지. */
  async function signedInWithInitialPassword() {
    const admin = await prisma.adminAccount.create({
      data: {
        loginId: `pwc${randomInt(10_000_000, 99_999_999)}`,
        bpCodeId,
        name: '홍길동',
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
        isPasswordChangeRequired: true,
      },
    });
    adminIds.push(admin.adminAccountId);
    const expiresAt = new Date(Date.now() + 20 * MIN);
    await prisma.temporaryPassword.create({
      data: {
        adminAccountId: admin.adminAccountId,
        passwordHash: await hashPassword(TEMP),
        expiresAt,
        purpose: 'INITIAL',
      },
    });
    const res = await login(admin.loginId, TEMP).expect(200);
    return { admin, expiresAt, ...(res.body as AdminLoginResponseDto) };
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
    authed('post', '/auth/admin/password-change', token).send(body);
  const messageOf = (res: { body: unknown }) =>
    (res.body as { message: string }).message;

  it('바꾸기 전에는 로그인 정보 · 로그아웃 경로만 열리고 업무 API 는 403', async () => {
    const { accessToken } = await signedInWithInitialPassword();

    const info = await authed('get', '/auth/admin/login-info', accessToken);
    expect(info.status).toBe(200);
    const { account } = info.body as AdminLoginInfoResponseDto;
    expect(account.isPasswordChangeRequired).toBe(true);
    expect(account.isTermsAgreementRequired).toBe(true);

    const blocked = await authed('get', '/stores', accessToken);
    expect(blocked.status).toBe(403);
    expect(messageOf(blocked)).toBe(PASSWORD_CHANGE_REQUIRED_MESSAGE);
  });

  it('약관 미동의 · 정책 위반은 400 과 문구 하나이고 아무것도 바꾸지 않는다', async () => {
    const { admin, accessToken } = await signedInWithInitialPassword();
    const bad = async (body: object, message: string) => {
      const res = await change(accessToken, body);
      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(message);
    };

    await bad(
      { newPassword: NEW, newPasswordConfirm: NEW },
      TERMS_REQUIRED_MESSAGE,
    );
    await bad(
      {
        newPassword: 'short',
        newPasswordConfirm: 'short',
        isTermsAgreed: true,
      },
      ADMIN_PASSWORD_MESSAGES.combination,
    );
    await bad(
      {
        newPassword: 'New pass 12!',
        newPasswordConfirm: 'New pass 12!',
        isTermsAgreed: true,
      },
      ADMIN_PASSWORD_MESSAGES.invalidCharacter,
    );
    await bad(
      { newPassword: NEW, newPasswordConfirm: NEW + 'x', isTermsAgreed: true },
      ADMIN_PASSWORD_MESSAGES.confirmMismatch,
    );

    const stored = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(stored.passwordHash).toBe('!');
    expect(stored.isPasswordChangeRequired).toBe(true);
    expect(stored.termsAgreedAt).toBeNull();
  });

  it('발급받은 비밀번호와 같으면 400', async () => {
    const { accessToken } = await signedInWithInitialPassword();
    const issued = 'Issued-pass-1!';
    const [temp] = await prisma.temporaryPassword.findMany({
      where: { adminAccountId: adminIds.at(-1) },
    });
    await prisma.temporaryPassword.update({
      where: { temporaryPasswordId: temp.temporaryPasswordId },
      data: { passwordHash: await hashPassword(issued) },
    });
    const res = await change(accessToken, {
      newPassword: issued,
      newPasswordConfirm: issued,
      isTermsAgreed: true,
    });
    expect(res.status).toBe(400);
    expect(messageOf(res)).toBe(ADMIN_PASSWORD_MESSAGES.sameAsIssued);
  });

  it('바꾸면 약관 동의까지 저장되고, 세션은 이어지며, 이후 로그인은 새 비밀번호로만 된다', async () => {
    const { admin, accessToken, refreshToken, expiresAt } =
      await signedInWithInitialPassword();

    const res = await change(accessToken, {
      newPassword: NEW,
      newPasswordConfirm: NEW,
      isTermsAgreed: true,
    });
    expect(res.status).toBe(204);

    // 같은 접근 토큰으로 업무 API 가 열린다(점포 목록).
    expect((await authed('get', '/stores', accessToken)).status).toBe(200);
    // 초기 비밀번호 만료로 잘려 있던 세션이 풀린다.
    const refreshed = (
      await request(app.getHttpServer())
        .post('/auth/admin/refresh')
        .send({ refreshToken })
        .expect(200)
    ).body as AdminRefreshResponseDto;
    expect(new Date(refreshed.refreshTokenExpiresAt).getTime()).toBeGreaterThan(
      expiresAt.getTime(),
    );

    const stored = await prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(stored.isPasswordChangeRequired).toBe(false);
    expect(stored.termsAgreedAt).not.toBeNull();
    expect(stored.termsOfUseVersionId).not.toBeNull();
    expect(stored.privacyVersionId).not.toBeNull();
    const logs = await prisma.termsAgreementLog.findMany({
      where: { adminAccountId: admin.adminAccountId },
    });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.channel === 'FIRST_LOGIN' && l.isAgreed)).toBe(
      true,
    );
    expect(
      await prisma.adminChangeHistory.count({
        where: { adminAccountId: admin.adminAccountId, field: '비밀번호' },
      }),
    ).toBe(1);

    expect((await login(admin.loginId, TEMP)).status).toBe(401);
    expect((await login(admin.loginId, NEW)).status).toBe(200);
    // 다시 부르면 대상이 아니다.
    expect(
      (await change(accessToken, { newPassword: NEW, newPasswordConfirm: NEW }))
        .status,
    ).toBe(409);
  });

  // 로그인에 쓴 임시 비밀번호가 없어진 강제 변경 세션은 끝난다 — 바꿀 수도(401) 쓸 수도(403) 없는 채로 남지 않게.
  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/auth/admin/refresh')
      .send({ refreshToken });

  it('로그인에 쓴 임시 비밀번호가 다시 발급으로 끝나면 변경은 다시 로그인 401, 갱신도 401 — 새 비밀번호로 들어오면 바꿀 수 있다', async () => {
    const { admin, accessToken, refreshToken } =
      await signedInWithInitialPassword();
    // 임시 비밀번호를 다시 받은 것과 같은 상태: 앞의 것은 끝나고 새 것이 생긴다.
    const fresh = 'Fresh-pass-12';
    await prisma.temporaryPassword.updateMany({
      where: { adminAccountId: admin.adminAccountId, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    });
    await prisma.temporaryPassword.create({
      data: {
        adminAccountId: admin.adminAccountId,
        passwordHash: await hashPassword(fresh),
        expiresAt: new Date(Date.now() + 60 * MIN),
        purpose: 'TEMPORARY',
      },
    });

    const res = await change(accessToken, {
      newPassword: NEW,
      newPasswordConfirm: NEW,
      isTermsAgreed: true,
    });
    expect(res.status).toBe(401);
    expect(messageOf(res)).toBe(RELOGIN_REQUIRED_MESSAGE);
    expect((await refresh(refreshToken)).status).toBe(401);
    // 갱신이 세션을 끝냈다 — 남은 접근 토큰도 막힌다.
    expect(
      (await authed('get', '/auth/admin/login-info', accessToken)).status,
    ).toBe(401);

    const again = (await login(admin.loginId, fresh).expect(200))
      .body as AdminLoginResponseDto;
    expect(
      (
        await change(again.accessToken, {
          newPassword: NEW,
          newPasswordConfirm: NEW,
          isTermsAgreed: true,
        })
      ).status,
    ).toBe(204);
  });

  it('본인 비밀번호로 로그인 중에 관리자가 초기화하면(표시만 켜짐) 갱신은 401 로 세션을 끝낸다', async () => {
    const own = 'Own-pass-123!';
    const admin = await prisma.adminAccount.create({
      data: {
        loginId: `pwr${randomInt(10_000_000, 99_999_999)}`,
        bpCodeId,
        name: '홍길동',
        passwordHash: await hashPassword(own),
        roleTypeCode: 'BM',
        roleGroupId,
        joinPathCode: 'SIGNUP',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    });
    adminIds.push(admin.adminAccountId);
    const { accessToken, refreshToken } = (
      await login(admin.loginId, own).expect(200)
    ).body as AdminLoginResponseDto;
    // 플랫폼 관리자 초기화와 같은 상태: 본인 비밀번호를 막고 강제 변경 표시를 켠다.
    await prisma.adminAccount.update({
      where: { adminAccountId: admin.adminAccountId },
      data: { passwordHash: '!', isPasswordChangeRequired: true },
    });

    const res = await change(accessToken, {
      newPassword: NEW,
      newPasswordConfirm: NEW,
    });
    expect(res.status).toBe(401);
    expect(messageOf(res)).toBe(RELOGIN_REQUIRED_MESSAGE);
    expect((await refresh(refreshToken)).status).toBe(401);
  });
});
