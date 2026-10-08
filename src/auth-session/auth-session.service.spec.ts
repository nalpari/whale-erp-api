import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../auth/password';
import {
  AuthSessionService,
  SESSION_LIFETIME_DAYS,
} from './auth-session.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('AuthSessionService', () => {
  let service: AuthSessionService;
  let prisma: {
    authSession: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    loginHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  const now = new Date('2026-10-07T03:00:00.000Z');

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      authSession: {
        create: jest.fn().mockResolvedValue({ authSessionId: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      loginHistory: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthSessionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AuthSessionService);
  });

  afterEach(() => jest.useRealTimers());

  // authSession.create 에 넘어간 data. 목의 호출 인자는 any 라 한곳에서 타입을 준다.
  const createdData = () =>
    (
      prisma.authSession.create.mock.calls[0] as [
        { data: { refreshTokenHash: string } },
      ]
    )[0].data;

  describe('issue', () => {
    it('계정·기기 식별 정보·만료 시각을 접속 상태로 저장한다', async () => {
      await service.issue({ accountId: 7, deviceIdentifier: 'iphone-1' });

      expect(createdData()).toMatchObject({
        accountId: 7,
        deviceIdentifier: 'iphone-1',
        expiresAt: new Date(now.getTime() + SESSION_LIFETIME_DAYS * DAY_MS),
      });
    });

    it('접속 상태를 30일 유지한다', () => {
      expect(SESSION_LIFETIME_DAYS).toBe(30);
    });

    it('갱신 토큰 원문은 돌려주고, 저장하는 것은 해시뿐이다', async () => {
      const result = await service.issue({ accountId: 7 });

      const data = createdData();
      expect(data.refreshTokenHash).toBe(hashToken(result.refreshToken));
      expect(JSON.stringify(data)).not.toContain(result.refreshToken);
    });

    it('만료 시각과 접속 ID 를 돌려준다', async () => {
      const result = await service.issue({ accountId: 7 });

      expect(result.authSessionId).toBe(1);
      expect(result.expiresAt).toEqual(new Date(now.getTime() + 30 * DAY_MS));
    });

    it('발급할 때마다 다른 갱신 토큰을 만든다', async () => {
      const first = await service.issue({ accountId: 7 });
      const second = await service.issue({ accountId: 7 });

      expect(first.refreshToken).not.toBe(second.refreshToken);
    });

    it('기기 식별 정보가 없으면 null 로 저장한다', async () => {
      await service.issue({ accountId: 7 });

      expect(createdData()).toMatchObject({ deviceIdentifier: null });
    });

    describe('여러 기기', () => {
      it('같은 기기로 다시 로그인하면 그 기기의 이전 접속 상태만 종료한다', async () => {
        await service.issue({ accountId: 7, deviceIdentifier: 'iphone-1' });

        expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
          where: {
            accountId: 7,
            deviceIdentifier: 'iphone-1',
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
      });

      it('다른 기기의 접속 상태는 건드리지 않는다', async () => {
        await service.issue({ accountId: 7, deviceIdentifier: 'iphone-1' });

        const [{ where }] = prisma.authSession.updateMany.mock.calls[0] as [
          { where: { deviceIdentifier: string } },
        ];
        expect(where.deviceIdentifier).toBe('iphone-1');
        expect(where).not.toHaveProperty('authSessionId');
      });

      it('기기를 구분할 수 없으면 기존 접속 상태를 종료하지 않는다', async () => {
        await service.issue({ accountId: 7 });

        expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
      });

      it('이전 접속 상태를 종료한 뒤에 새 접속 상태를 만든다', async () => {
        await service.issue({ accountId: 7, deviceIdentifier: 'iphone-1' });

        const [revokeOrder] =
          prisma.authSession.updateMany.mock.invocationCallOrder;
        const [createOrder] =
          prisma.authSession.create.mock.invocationCallOrder;
        expect(revokeOrder).toBeLessThan(createOrder);
      });

      it('이전 접속 종료와 새 접속 생성을 한 트랜잭션에서 한다', async () => {
        prisma.$transaction.mockImplementation(() => Promise.resolve());

        await service
          .issue({ accountId: 7, deviceIdentifier: 'iphone-1' })
          .catch(() => undefined);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
        expect(prisma.authSession.create).not.toHaveBeenCalled();
      });

      it('트랜잭션 클라이언트를 받으면 그 안에서 종료·생성한다 — 로그인 성공 처리와 한 트랜잭션이어야 해서', async () => {
        const tx = {
          authSession: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue({ authSessionId: 9 }),
          },
        };

        const result = await service.issue(
          { accountId: 7, deviceIdentifier: 'iphone-1' },
          tx as unknown as Parameters<AuthSessionService['issue']>[1],
        );

        expect(result.authSessionId).toBe(9);
        expect(tx.authSession.updateMany).toHaveBeenCalled();
        expect(tx.authSession.create).toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.authSession.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('recordLoginAttempt', () => {
    it('성공한 시도는 계정과 이메일을 성공으로 남긴다', async () => {
      await service.recordLoginAttempt({
        accountId: 7,
        email: 'staff@whale.test',
        isSucceeded: true,
      });

      expect(prisma.loginHistory.create).toHaveBeenCalledWith({
        data: {
          accountId: 7,
          email: 'staff@whale.test',
          isSucceeded: true,
          failureReason: null,
        },
      });
    });

    it('실패한 시도는 실패 사유를 남긴다', async () => {
      await service.recordLoginAttempt({
        accountId: 7,
        email: 'staff@whale.test',
        isSucceeded: false,
        failureReason: 'PASSWORD_MISMATCH',
      });

      expect(prisma.loginHistory.create).toHaveBeenCalledWith({
        data: {
          accountId: 7,
          email: 'staff@whale.test',
          isSucceeded: false,
          failureReason: 'PASSWORD_MISMATCH',
        },
      });
    });

    it('없는 이메일이면 계정을 비우고 시도한 이메일만 남긴다', async () => {
      await service.recordLoginAttempt({
        email: 'nobody@whale.test',
        isSucceeded: false,
        failureReason: 'ACCOUNT_NOT_FOUND',
      });

      expect(prisma.loginHistory.create).toHaveBeenCalledWith({
        data: {
          accountId: null,
          email: 'nobody@whale.test',
          isSucceeded: false,
          failureReason: 'ACCOUNT_NOT_FOUND',
        },
      });
    });
  });

  describe('validate', () => {
    beforeEach(() => {
      prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    });

    const stored = (overrides: object = {}) => ({
      authSessionId: 3,
      accountId: 7,
      deviceIdentifier: 'iphone-1',
      expiresAt: new Date(now.getTime() + DAY_MS),
      revokedAt: null,
      account: { status: 'JOINED' },
      ...overrides,
    });

    it('받은 토큰의 해시로 접속 상태를 찾는다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(stored());

      await service.validate('refresh-token');

      expect(prisma.authSession.findUnique).toHaveBeenCalledWith({
        where: { refreshTokenHash: hashToken('refresh-token') },
        include: { account: { select: { status: true } } },
      });
    });

    it('유효하면 접속 상태를 돌려준다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(stored());

      await expect(service.validate('refresh-token')).resolves.toEqual({
        authSessionId: 3,
        accountId: 7,
        deviceIdentifier: 'iphone-1',
        expiresAt: new Date(now.getTime() + 30 * DAY_MS),
      });
    });

    it('모르는 토큰이면 401 이다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(null);

      await expect(service.validate('unknown')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('만료 시각이 지났으면 401 이다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ expiresAt: new Date(now.getTime() - 1) }),
      );

      await expect(service.validate('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('만료 시각과 정확히 같은 순간도 만료로 본다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ expiresAt: now }),
      );

      await expect(service.validate('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('종료된 접속 상태면 401 이다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ revokedAt: new Date(now.getTime() - 1000) }),
      );

      await expect(service.validate('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('탈퇴한 계정의 접속 상태면 401 이고 만료를 연장하지 않는다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ account: { status: 'WITHDRAWN' } }),
      );

      await expect(service.validate('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    });

    it('만료와 종료와 미존재와 탈퇴를 같은 메시지로 답한다', async () => {
      const messages: string[] = [];
      for (const row of [
        null,
        stored({ expiresAt: new Date(now.getTime() - 1) }),
        stored({ revokedAt: now }),
        stored({ account: { status: 'WITHDRAWN' } }),
      ]) {
        prisma.authSession.findUnique.mockResolvedValue(row);
        await service
          .validate('t')
          .catch((e: Error) => messages.push(e.message));
      }

      expect(new Set(messages).size).toBe(1);
      expect(messages).toHaveLength(4);
    });

    it('사용할 때마다 마지막 사용 시각을 갱신하고 만료를 지금부터 30일 뒤로 민다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ expiresAt: new Date(now.getTime() + DAY_MS) }),
      );

      await service.validate('refresh-token');

      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: {
          authSessionId: 3,
          revokedAt: null,
          expiresAt: { gt: now },
          account: { status: { not: 'WITHDRAWN' } },
        },
        data: {
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + 30 * DAY_MS),
        },
      });
    });

    it('거부한 요청은 만료를 연장하지 않는다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        stored({ expiresAt: new Date(now.getTime() - 1) }),
      );

      await service.validate('refresh-token').catch(() => undefined);

      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    });

    it('확인과 갱신 사이에 종료되거나 만료됐으면 401 이다', async () => {
      prisma.authSession.findUnique.mockResolvedValue(stored());
      prisma.authSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.validate('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('revokeAll', () => {
    it.each([undefined, null, Number.NaN, 1.5])(
      '계정 ID 가 정수가 아니면(%p) 아무것도 종료하지 않고 던진다 — 조건이 빠지면 모든 계정의 접속이 끊긴다',
      async (bad) => {
        await expect(
          service.revokeAll(bad as unknown as number),
        ).rejects.toThrow();
        expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
      },
    );

    it('그 계정의 살아 있는 접속 상태를 모두 종료한다', async () => {
      await service.revokeAll(7);

      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    it('종료한 접속 상태의 수를 돌려준다', async () => {
      prisma.authSession.updateMany.mockResolvedValue({ count: 3 });

      await expect(service.revokeAll(7)).resolves.toBe(3);
    });

    it('트랜잭션 클라이언트를 받으면 그 클라이언트로 종료한다 — 비밀번호 변경과 한 트랜잭션이어야 해서', async () => {
      const tx = {
        authSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };

      const count = await service.revokeAll(
        7,
        tx as unknown as Parameters<AuthSessionService['revokeAll']>[1],
      );

      expect(count).toBe(2);
      expect(tx.authSession.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, revokedAt: null },
        data: { revokedAt: now },
      });
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('isActive', () => {
    it('그 계정의 종료되지 않고 만료되지 않은 접속 상태가 있으면 true', async () => {
      prisma.authSession.count.mockResolvedValue(1);

      await expect(service.isActive(11, 7)).resolves.toBe(true);
    });

    it('종료됐거나 만료됐거나 다른 계정의 것이면 false', async () => {
      prisma.authSession.count.mockResolvedValue(0);

      await expect(service.isActive(11, 7)).resolves.toBe(false);
    });

    it('접속 ID·계정·종료 안 됨·만료 전·탈퇴 안 함을 한 번에 조건으로 건다', async () => {
      await service.isActive(11, 7);

      expect(prisma.authSession.count).toHaveBeenCalledWith({
        where: {
          authSessionId: 11,
          accountId: 7,
          revokedAt: null,
          expiresAt: { gt: now },
          account: { status: { not: 'WITHDRAWN' } },
        },
      });
    });

    it('읽기만 한다 — 마지막 사용 시각과 만료를 건드리지 않는다', async () => {
      await service.isActive(11, 7);

      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('그 접속 상태 하나만 종료한다', async () => {
      await service.revoke(11);

      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: { authSessionId: 11, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    it('이미 종료된 것이어도 던지지 않는다 — 로그아웃은 다시 불러도 같은 결과', async () => {
      prisma.authSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revoke(11)).resolves.toBeUndefined();
    });

    it.each([undefined, null, Number.NaN, 1.5])(
      '접속 ID 가 정수가 아니면(%p) 아무것도 종료하지 않고 던진다 — 조건이 빠지면 모든 접속이 끊긴다',
      async (bad) => {
        await expect(
          service.revoke(bad as unknown as number),
        ).rejects.toThrow();
        expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
      },
    );
  });
});
