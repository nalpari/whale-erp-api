import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { hashToken } from '../src/auth/password';
import {
  AuthSessionService,
  SESSION_LIFETIME_DAYS,
} from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// 실제 DB 를 상대로 접속 상태의 규칙을 확인한다. 단위 테스트(목)는 "이런
// 쿼리를 보낸다"까지만 증명하고, 조건부 갱신이 정말 행을 거르는지, 제약이
// 정말 걸리는지는 DB 가 답해야 한다.
describe('AuthSessionService (DB)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: AuthSessionService;
  // 이 파일이 만든 계정만 지운다. 공유 DB 의 다른 행은 건드리지 않는다.
  const createdAccountIds: number[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error(
        'DATABASE_URL 이 없습니다. 마이그레이션이 적용된 DB 를 가리켜야 합니다.',
      );
    module = await Test.createTestingModule({
      providers: [AuthSessionService, PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = module.get(AuthSessionService);
  });

  afterAll(async () => {
    if (createdAccountIds.length > 0) {
      const where = { accountId: { in: createdAccountIds } };
      // 자식부터 지운다. 외래키가 RESTRICT 라 계정이 먼저 지워지지 않는다.
      await prisma.authSession.deleteMany({ where });
      await prisma.loginHistory.deleteMany({ where });
      await prisma.account.deleteMany({ where });
    }
    await module?.close();
  });

  async function createAccount(): Promise<number> {
    const unique = randomUUID();
    const { accountId } = await prisma.account.create({
      data: {
        email: `${unique}@test.invalid`,
        passwordHash: '!',
        realName: '테스트',
        birthDate: new Date('1990-01-01'),
        phone: '01012345678',
        status: 'JOINED',
      },
    });
    createdAccountIds.push(accountId);
    return accountId;
  }

  const sessionsOf = (accountId: number) =>
    prisma.authSession.findMany({
      where: { accountId },
      orderBy: { authSessionId: 'asc' },
    });

  describe('issue', () => {
    it('접속 상태를 저장하고 갱신 토큰은 해시로만 남긴다', async () => {
      const accountId = await createAccount();

      const issued = await service.issue({ accountId, deviceIdentifier: 'a' });

      const [row] = await sessionsOf(accountId);
      expect(row.authSessionId).toBe(issued.authSessionId);
      expect(row.refreshTokenHash).toBe(hashToken(issued.refreshToken));
      expect(row.refreshTokenHash).not.toBe(issued.refreshToken);
      expect(row.revokedAt).toBeNull();
      // 만료는 발급 시각 + 30일이다.
      expect(row.expiresAt.getTime() - row.issuedAt.getTime()).toBeCloseTo(
        SESSION_LIFETIME_DAYS * DAY_MS,
        -4,
      );
    });

    it('같은 기기로 다시 로그인하면 이전 접속만 종료하고, 다른 기기는 유지한다', async () => {
      const accountId = await createAccount();
      await service.issue({ accountId, deviceIdentifier: 'phone' });
      await service.issue({ accountId, deviceIdentifier: 'tablet' });

      await service.issue({ accountId, deviceIdentifier: 'phone' });

      const rows = await sessionsOf(accountId);
      const live = (device: string) =>
        rows.filter((r) => r.deviceIdentifier === device && !r.revokedAt)
          .length;
      expect(live('phone')).toBe(1);
      expect(live('tablet')).toBe(1);
      expect(rows).toHaveLength(3);
    });

    it('없는 계정에는 접속 상태를 만들 수 없다', async () => {
      await expect(service.issue({ accountId: 2147483647 })).rejects.toThrow();
    });
  });

  describe('validate', () => {
    it('살아 있는 토큰이면 만료를 지금부터 30일 뒤로 민다', async () => {
      const accountId = await createAccount();
      const { refreshToken, authSessionId } = await service.issue({
        accountId,
      });
      // 29일 지난 상태로 만든다. 만료가 곧 닥친 접속이다.
      await prisma.authSession.update({
        where: { authSessionId },
        data: { expiresAt: new Date(Date.now() + DAY_MS) },
      });

      const before = Date.now();
      const valid = await service.validate(refreshToken);

      const [row] = await sessionsOf(accountId);
      expect(valid.accountId).toBe(accountId);
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + SESSION_LIFETIME_DAYS * DAY_MS - 1000,
      );
      expect(row.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('만료된 접속은 401 이고 만료를 연장하지 않는다', async () => {
      const accountId = await createAccount();
      const { refreshToken, authSessionId } = await service.issue({
        accountId,
      });
      const expiredAt = new Date(Date.now() - 1000);
      await prisma.authSession.update({
        where: { authSessionId },
        data: { expiresAt: expiredAt },
      });

      await expect(service.validate(refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      const [row] = await sessionsOf(accountId);
      expect(row.expiresAt).toEqual(expiredAt);
    });

    it('종료된 접속과 없는 토큰은 같은 메시지로 401 이다', async () => {
      const accountId = await createAccount();
      const { refreshToken } = await service.issue({ accountId });
      await service.revokeAll(accountId);

      const revoked = await service
        .validate(refreshToken)
        .catch((e: UnauthorizedException) => e.message);
      const unknown = await service
        .validate('없는-토큰')
        .catch((e: UnauthorizedException) => e.message);

      expect(revoked).toBe(unknown);
    });
  });

  describe('revokeAll', () => {
    it('그 계정의 모든 기기를 종료하고 다른 계정은 건드리지 않는다', async () => {
      const mine = await createAccount();
      const other = await createAccount();
      await service.issue({ accountId: mine, deviceIdentifier: 'phone' });
      await service.issue({ accountId: mine, deviceIdentifier: 'tablet' });
      await service.issue({ accountId: other, deviceIdentifier: 'phone' });

      const count = await service.revokeAll(mine);

      expect(count).toBe(2);
      expect((await sessionsOf(mine)).every((r) => r.revokedAt)).toBe(true);
      expect((await sessionsOf(other)).every((r) => !r.revokedAt)).toBe(true);
    });

    it('이미 종료된 접속의 종료 시각을 덮어쓰지 않는다', async () => {
      const accountId = await createAccount();
      await service.issue({ accountId });
      await service.revokeAll(accountId);
      const [first] = await sessionsOf(accountId);

      await expect(service.revokeAll(accountId)).resolves.toBe(0);

      const [second] = await sessionsOf(accountId);
      expect(second.revokedAt).toEqual(first.revokedAt);
    });
  });

  describe('recordLoginAttempt', () => {
    it('없는 이메일의 실패는 계정 없이 시도한 이메일만 남긴다', async () => {
      const email = `${randomUUID()}@test.invalid`;

      await service.recordLoginAttempt({
        email,
        isSucceeded: false,
        failureReason: 'ACCOUNT_NOT_FOUND',
      });

      const row = await prisma.loginHistory.findFirstOrThrow({
        where: { email },
      });
      expect(row.accountId).toBeNull();
      expect(row.isSucceeded).toBe(false);
      expect(row.failureReason).toBe('ACCOUNT_NOT_FOUND');
      await prisma.loginHistory.deleteMany({ where: { email } });
    });

    it('잠금 사유까지 DB 가 받아들이고 시도 시각을 채운다', async () => {
      const accountId = await createAccount();

      await service.recordLoginAttempt({
        accountId,
        email: 'locked@test.invalid',
        isSucceeded: false,
        failureReason: 'LOCKED',
      });

      const row = await prisma.loginHistory.findFirstOrThrow({
        where: { accountId },
      });
      expect(row.failureReason).toBe('LOCKED');
      expect(row.attemptedAt).toBeInstanceOf(Date);
    });
  });
});
