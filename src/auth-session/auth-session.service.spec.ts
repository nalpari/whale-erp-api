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
    authSession: { create: jest.Mock; updateMany: jest.Mock };
    loginHistory: { create: jest.Mock };
  };
  const now = new Date('2026-10-07T03:00:00.000Z');

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      authSession: {
        create: jest.fn().mockResolvedValue({ authSessionId: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      loginHistory: { create: jest.fn().mockResolvedValue({}) },
    };

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
});
