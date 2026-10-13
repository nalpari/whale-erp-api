import {
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './password';
import { PasswordResetLinkSender } from './password-reset-link-sender';
import { PasswordResetLinkService } from './password-reset-link.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const APP_URL = 'https://staff.whale-erp.com';

describe('PasswordResetLinkService', () => {
  const now = new Date('2026-10-13T03:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  let service: PasswordResetLinkService;
  let appUrl: string | undefined;
  let prisma: {
    staffMember: { findUnique: jest.Mock };
    account: { findUnique: jest.Mock };
    store: { findUnique: jest.Mock };
    passwordResetLink: { findUnique: jest.Mock; delete: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    passwordResetLink: {
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    passwordResetPin: { updateMany: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sender: { isAvailable: jest.Mock; send: jest.Mock };
  let sessions: { revokeAll: jest.Mock };

  const staff = (over: Record<string, unknown> = {}) => ({
    accountId: 7,
    storeId: 3,
    employmentStatus: 'EMPLOYED',
    ...over,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    appUrl = APP_URL;
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'JOINED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      passwordResetLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ passwordResetLinkId: 41 }),
      },
      passwordResetPin: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      staffMember: { findUnique: jest.fn().mockResolvedValue(staff()) },
      account: {
        findUnique: jest.fn().mockResolvedValue({
          accountId: 7,
          email: 'staff@example.com',
          realName: '홍길동',
          status: 'JOINED',
        }),
      },
      store: { findUnique: jest.fn().mockResolvedValue({ name: '연남점' }) },
      passwordResetLink: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    sender = {
      isAvailable: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(0) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordResetLinkSender, useValue: sender },
        { provide: AuthSessionService, useValue: sessions },
        { provide: ConfigService, useValue: { get: () => appUrl } },
      ],
    }).compile();
    service = module.get(PasswordResetLinkService);
  });

  afterEach(() => jest.useRealTimers());

  const sentLink = () =>
    (sender.send.mock.calls[0] as [unknown, { link: string }])[1].link;
  const tokenOf = (link: string) =>
    new URL(link).searchParams.get('token') as string;
  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('던지지 않았다');
  };

  describe('발급', () => {
    it('201 에 쓸 발송 시각과 24시간 뒤 기한을 돌려준다', async () => {
      await expect(service.issue(31, 5)).resolves.toEqual({
        issuedAt: now,
        expiresAt: at(24 * HOUR),
      });
    });

    it('토큰은 해시만 저장하고, 요청 관리자와 24시간 기한을 남긴다', async () => {
      await service.issue(31, 5);
      const token = tokenOf(sentLink());
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tx.passwordResetLink.create).toHaveBeenCalledWith({
        data: {
          accountId: 7,
          tokenHash: hashToken(token),
          issuedAt: now,
          expiresAt: at(24 * HOUR),
          requestedBy: 31,
        },
        select: { passwordResetLinkId: true },
      });
    });

    it('직원 앱의 재설정 링크와 점포 이름 · 요청 관리자로 보낸다', async () => {
      await service.issue(31, 5);
      expect(sender.send).toHaveBeenCalledWith(
        { accountId: 7, email: 'staff@example.com', realName: '홍길동' },
        expect.objectContaining({
          storeName: '연남점',
          expiresAt: at(24 * HOUR),
          requestedBy: 31,
        }),
      );
      expect(sentLink()).toMatch(
        /^https:\/\/staff\.whale-erp\.com\/password-reset\/link\?token=/,
      );
    });

    it('앞서 보낸 링크와 열린 핀을 같은 트랜잭션에서 닫는다', async () => {
      await service.issue(31, 5);
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null },
        data: { closedAt: now },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
    });

    it('계정 행을 잠근 뒤 직전 발급을 읽는다 — 동시에 눌러도 1분 제한을 넘지 못하게', async () => {
      await service.issue(31, 5);
      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetLink.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('같은 계정에 1분 안에 낸 링크가 있으면 429 이고 아무것도 바꾸지 않는다', async () => {
      tx.passwordResetLink.findFirst.mockResolvedValue({
        issuedAt: at(-MINUTE + 1),
      });
      const error = await thrown(service.issue(31, 5));
      expect(error.getStatus()).toBe(429);
      expect(tx.passwordResetLink.create).not.toHaveBeenCalled();
      expect(tx.passwordResetPin.updateMany).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('1분이 지났으면 다시 보낸다', async () => {
      tx.passwordResetLink.findFirst.mockResolvedValue({
        issuedAt: at(-MINUTE),
      });
      await expect(service.issue(31, 5)).resolves.toBeDefined();
    });

    it.each([
      ['가입 전(계정 없음)', staff({ accountId: null }), '가입'],
      ['퇴직', staff({ employmentStatus: 'RETIRED' }), '퇴직'],
    ])('%s 직원이면 409', async (_, row, word) => {
      prisma.staffMember.findUnique.mockResolvedValue(row);
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain(word);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('퇴직 예정(재직이고 퇴직일만 있음)은 보낼 수 있다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ employmentStatus: 'EMPLOYED' }),
      );
      await expect(service.issue(31, 5)).resolves.toBeDefined();
    });

    it('탈퇴한 계정이면 409', async () => {
      prisma.account.findUnique.mockResolvedValue({
        accountId: 7,
        email: 'staff@example.com',
        realName: '홍길동',
        status: 'WITHDRAWN',
      });
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('탈퇴');
    });

    it('없는 직원이면 404 — 범위 확인 뒤 사이에 지워진 경우', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(null);
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('STAFF_APP_URL 이 비었으면 503 이고 아무것도 저장하지 않는다', async () => {
      appUrl = undefined;
      const module = await Test.createTestingModule({
        providers: [
          PasswordResetLinkService,
          { provide: PrismaService, useValue: prisma },
          { provide: PasswordResetLinkSender, useValue: sender },
          { provide: AuthSessionService, useValue: sessions },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile();
      await expect(
        module.get(PasswordResetLinkService).issue(31, 5),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('발송기를 쓸 수 없으면 503 이고 아무것도 저장하지 않는다', async () => {
      sender.isAvailable.mockReturnValue(false);
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('발송에 실패하면 방금 만든 링크를 지우고 503 — 바로 다시 보낼 때 1분 제한에 걸리지 않게', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.passwordResetLink.delete).toHaveBeenCalledWith({
        where: { passwordResetLinkId: 41 },
      });
    });
  });
});
