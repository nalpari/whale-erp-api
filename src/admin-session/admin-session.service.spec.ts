import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { hashToken } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_SESSION_LIFETIME_MS,
  AdminSessionService,
} from './admin-session.service';

describe('AdminSessionService', () => {
  let service: AdminSessionService;
  let prisma: {
    adminSession: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  const now = new Date('2026-10-13T03:00:00.000Z');
  const later = (ms: number) => new Date(now.getTime() + ms);

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      adminSession: {
        create: jest.fn().mockResolvedValue({ sessionId: 41 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminSessionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AdminSessionService);
  });

  afterEach(() => jest.useRealTimers());

  const sign = jest.fn((sid: number) => Promise.resolve(`access-for-${sid}`));

  describe('issue', () => {
    it('갱신 토큰은 마지막 사용부터 1시간이다', () => {
      expect(ADMIN_SESSION_LIFETIME_MS).toBe(60 * 60 * 1000);
    });

    it('세션을 만들고 그 id 로 서명한 접근 토큰의 해시를 남긴다', async () => {
      const issued = await service.issue(
        { adminAccountId: 7, deviceInformation: 'chrome-1' },
        sign,
      );

      expect(prisma.adminSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          adminAccountId: 7,
          deviceInformation: 'chrome-1',
          refreshLastUsedAt: now,
          expiresAt: later(ADMIN_SESSION_LIFETIME_MS),
        }) as unknown,
      });
      expect(issued.accessToken).toBe('access-for-41');
      expect(prisma.adminSession.update).toHaveBeenCalledWith({
        where: { sessionId: 41 },
        data: {
          accessTokenHash: hashToken('access-for-41'),
          refreshTokenHash: hashToken(issued.refreshToken),
        },
      });
    });

    it('갱신 토큰은 세션 id 로 시작하고 저장하는 것은 해시뿐이다', async () => {
      const issued = await service.issue({ adminAccountId: 7 }, sign);

      expect(issued.refreshToken.startsWith('41.')).toBe(true);
      const created = (
        prisma.adminSession.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(Object.values(created)).not.toContain(issued.refreshToken);
    });

    it('만료 상한이 1시간보다 이르면 상한에서 끝난다 — 임시 비밀번호 세션', async () => {
      const cap = later(10 * 60 * 1000);
      const issued = await service.issue(
        { adminAccountId: 7, expiresAtCap: cap },
        sign,
      );
      expect(issued.expiresAt).toEqual(cap);
    });

    it('같은 기기의 이전 세션만 종료한다', async () => {
      await service.issue(
        { adminAccountId: 7, deviceInformation: 'chrome-1' },
        sign,
      );
      expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 7,
          deviceInformation: 'chrome-1',
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
    });

    it('기기를 모르면 다른 세션을 건드리지 않는다', async () => {
      await service.issue({ adminAccountId: 7 }, sign);
      expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('find', () => {
    const live = (over: Record<string, unknown> = {}) => ({
      sessionId: 41,
      adminAccountId: 7,
      refreshTokenHash: hashToken('41.secret'),
      revokedAt: null,
      isDeleted: false,
      expiresAt: later(1000),
      adminAccount: { accountStatusCode: 'ACTIVE', isDeleted: false },
      ...over,
    });

    it('살아 있는 세션을 id 로 찾아 해시를 대조한다', async () => {
      prisma.adminSession.findUnique.mockResolvedValue(live());
      await expect(service.find('41.secret')).resolves.toEqual({
        sessionId: 41,
        adminAccountId: 7,
      });
      expect(prisma.adminSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionId: 41 } }),
      );
    });

    it.each([
      ['모양이 다른 토큰', 'nonsense', null],
      ['없는 세션', '41.secret', null],
      ['해시 불일치', '41.other', live()],
      ['종료된 세션', '41.secret', live({ revokedAt: now })],
      ['삭제된 세션', '41.secret', live({ isDeleted: true })],
      ['만료 시각과 같은 순간', '41.secret', live({ expiresAt: now })],
      [
        '미사용 계정',
        '41.secret',
        live({
          adminAccount: { accountStatusCode: 'INACTIVE', isDeleted: false },
        }),
      ],
      [
        '탈퇴 계정',
        '41.secret',
        live({
          adminAccount: { accountStatusCode: 'WITHDRAWN', isDeleted: false },
        }),
      ],
      [
        '삭제된 계정',
        '41.secret',
        live({
          adminAccount: { accountStatusCode: 'ACTIVE', isDeleted: true },
        }),
      ],
    ])('%s 은 같은 401', async (_, token, row) => {
      prisma.adminSession.findUnique.mockResolvedValue(row);
      await expect(service.find(token)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('extend', () => {
    it('살아 있는 조건을 다시 걸고 만료를 민다', async () => {
      const expiresAt = await service.extend(41, 'new-access');

      expect(expiresAt).toEqual(later(ADMIN_SESSION_LIFETIME_MS));
      expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({
        where: {
          sessionId: 41,
          revokedAt: null,
          isDeleted: false,
          expiresAt: { gt: now },
          adminAccount: { accountStatusCode: 'ACTIVE', isDeleted: false },
        },
        data: {
          refreshLastUsedAt: now,
          expiresAt: later(ADMIN_SESSION_LIFETIME_MS),
          accessTokenHash: hashToken('new-access'),
        },
      });
    });

    it('상한이 있으면 상한을 넘겨 밀지 않는다', async () => {
      const cap = later(60_000);
      await expect(service.extend(41, 'a', cap)).resolves.toEqual(cap);
    });

    it('상한이 이미 지났으면 401', async () => {
      await expect(service.extend(41, 'a', now)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
    });

    it('그 사이 종료되었으면 되살리지 않고 401', async () => {
      prisma.adminSession.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.extend(41, 'a')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('isActive', () => {
    it('세션 id 와 계정을 함께 건다', async () => {
      await expect(service.isActive(41, 7)).resolves.toBe(true);
      expect(prisma.adminSession.count).toHaveBeenCalledWith({
        where: {
          sessionId: 41,
          adminAccountId: 7,
          revokedAt: null,
          isDeleted: false,
          expiresAt: { gt: now },
        },
      });
    });

    it('없으면 false', async () => {
      prisma.adminSession.count.mockResolvedValue(0);
      await expect(service.isActive(41, 7)).resolves.toBe(false);
    });
  });

  describe('revoke', () => {
    it('그 세션만 종료한다', async () => {
      await service.revoke(41);
      expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({
        where: { sessionId: 41, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    it('정수가 아니면 던진다 — 조건이 빠져 전체가 종료되지 않게', async () => {
      await expect(
        service.revoke(undefined as unknown as number),
      ).rejects.toThrow();
      expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
    });
  });
});
