import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import * as mailService from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './password';
import { PasswordResetLinkSender } from './password-reset-link-sender';
import { PasswordResetLinkService } from './password-reset-link.service';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hashPassword } from './password';

jest.mock('./password', () => ({
  ...jest.requireActual<typeof import('./password')>('./password'),
  hashPassword: jest.fn((plain: string) => Promise.resolve(`hash:${plain}`)),
}));
const hashPasswordMock = hashPassword as jest.Mock;
const NEW_PASSWORD = 'Brand-new-pw1';

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
    passwordResetLink: { findUnique: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    staffMember: { findUniqueOrThrow: jest.Mock };
    passwordResetLink: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    passwordResetPin: { updateMany: jest.Mock };
    emailChangePin: { updateMany: jest.Mock };
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
    // MailService 가 SMTP 단계 예외에 붙이는 표시를 흉내 낸다 — 'smtp' 로 시작하는 오류만 SMTP 실패다
    jest
      .spyOn(mailService, 'isMailTransportError')
      .mockImplementation(
        (e: unknown) => e instanceof Error && e.message.startsWith('smtp'),
      );
    appUrl = APP_URL;
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'JOINED',
          email: 'staff@example.com',
          realName: '홍길동',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      staffMember: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ employmentStatus: 'EMPLOYED' }),
      },
      passwordResetLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ passwordResetLinkId: 41 }),
      },
      passwordResetPin: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      emailChangePin: {
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
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
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

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const sentLink = () =>
    (sender.send.mock.calls[0] as [unknown, { link: string }])[1].link;
  const tokenOf = (link: string) =>
    new URLSearchParams(new URL(link).hash.slice(1)).get('token') as string;
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

    it('잠그기 전에 읽은 뒤 직원이 이메일을 바꿨으면 잠금 안에서 다시 읽은 새 주소로 보낸다 — 옛 주소로 링크가 나가지 않게', async () => {
      tx.account.findUniqueOrThrow.mockResolvedValue({
        status: 'JOINED',
        email: 'changed@example.com',
        realName: '홍길동',
      });
      await service.issue(31, 5);
      expect(tx.account.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { accountId: 7 },
        select: { status: true, email: true, realName: true },
      });
      expect(sender.send).toHaveBeenCalledWith(
        { accountId: 7, email: 'changed@example.com', realName: '홍길동' },
        expect.anything(),
      );
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
        /^https:\/\/staff\.whale-erp\.com\/password-reset\/link#token=/,
      );
    });

    it('보낸 뒤에 이번 발급보다 앞선 링크와 열린 핀을 닫는다 — 메일이 안 나갔는데 받아 둔 핀이 죽지 않게', async () => {
      await service.issue(31, 5);
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null, issuedAt: { lt: now } },
        data: { closedAt: now },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null, issuedAt: { lt: now } },
        data: { usedAt: now },
      });
      const sent = sender.send.mock.invocationCallOrder[0];
      expect(
        tx.passwordResetLink.updateMany.mock.invocationCallOrder[0],
      ).toBeGreaterThan(sent);
      expect(
        tx.passwordResetPin.updateMany.mock.invocationCallOrder[0],
      ).toBeGreaterThan(sent);
    });

    it('닫힌 시각은 발급 시각이 아니라 실제로 닫은 시각이다 — 발송에 걸린 시간만큼 앞당겨 적지 않게', async () => {
      sender.send.mockImplementation(() => {
        jest.setSystemTime(at(5000));
        return Promise.resolve();
      });
      await service.issue(31, 5);
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null, issuedAt: { lt: now } },
        data: { closedAt: at(5000) },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null, issuedAt: { lt: now } },
        data: { usedAt: at(5000) },
      });
    });

    it('메일이 나간 뒤 닫기가 실패해도 201 이고 오류 로그를 남긴다 — 직원은 이미 링크를 받았다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      error.mockClear();
      prisma.$transaction
        .mockImplementationOnce((work: (client: typeof tx) => unknown) =>
          work(tx),
        )
        .mockRejectedValueOnce(new Error('db down'));
      await expect(service.issue(31, 5)).resolves.toEqual({
        issuedAt: now,
        expiresAt: at(24 * HOUR),
      });
      expect(sender.send).toHaveBeenCalled();
      expect(prisma.passwordResetLink.deleteMany).not.toHaveBeenCalled();
      const messages = error.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((m) => m.includes('앞선 링크 · 핀을 닫지 못했다')),
      ).toBe(true);
    });

    it('닫기도 계정 행을 잠근 뒤에 한다', async () => {
      await service.issue(31, 5);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      const [strings] = tx.$queryRaw.mock.calls[1] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeGreaterThan(
        sender.send.mock.invocationCallOrder[0],
      );
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.passwordResetLink.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('발송에 실패하면 앞선 링크 · 핀을 닫지 않는다 — 직원이 받아 둔 것은 그대로 쓸 수 있다', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      await thrown(service.issue(31, 5));
      expect(tx.passwordResetLink.updateMany).not.toHaveBeenCalled();
      expect(tx.passwordResetPin.updateMany).not.toHaveBeenCalled();
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

    it('퇴직 예정(재직이고 퇴직일만 있음)은 보낼 수 있다 — 퇴직일이 아니라 재직 상태로 가른다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({
          employmentStatus: 'EMPLOYED',
          retiredDate: at(30 * 24 * HOUR),
        }),
      );
      await expect(service.issue(31, 5)).resolves.toBeDefined();
      expect(tx.passwordResetLink.create).toHaveBeenCalled();
      expect(sender.send).toHaveBeenCalled();
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

    it('운영에서 STAFF_APP_URL 이 비었으면 기동 때 오류 로그를 남긴다 — 첫 발송 때가 아니라 배포 때 알게', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const before = process.env.APP_ENV;
      process.env.APP_ENV = 'prod';
      try {
        await Test.createTestingModule({
          providers: [
            PasswordResetLinkService,
            { provide: PrismaService, useValue: prisma },
            { provide: PasswordResetLinkSender, useValue: sender },
            { provide: AuthSessionService, useValue: sessions },
            { provide: ConfigService, useValue: { get: () => undefined } },
          ],
        }).compile();
      } finally {
        process.env.APP_ENV = before;
      }
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('STAFF_APP_URL'),
      );
    });

    it('운영이 아니면 STAFF_APP_URL 이 비어도 오류 로그를 남기지 않는다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      error.mockClear();
      await Test.createTestingModule({
        providers: [
          PasswordResetLinkService,
          { provide: PrismaService, useValue: prisma },
          { provide: PasswordResetLinkSender, useValue: sender },
          { provide: AuthSessionService, useValue: sessions },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile();
      expect(error).not.toHaveBeenCalled();
    });

    it('발송기를 쓸 수 없으면 503 이고 아무것도 저장하지 않는다 — 기다려도 풀리지 않으니 설정 문제라고 알린다', async () => {
      sender.isAvailable.mockReturnValue(false);
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toBe(
        '메일 발송이 설정되지 않아 재설정 링크를 보낼 수 없습니다. 운영자에게 문의해 주세요.',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('운영에서 발송기를 쓸 수 없으면 기동 때 오류 로그를 남긴다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      error.mockClear();
      sender.isAvailable.mockReturnValue(false);
      const before = process.env.APP_ENV;
      process.env.APP_ENV = 'prod';
      try {
        await Test.createTestingModule({
          providers: [
            PasswordResetLinkService,
            { provide: PrismaService, useValue: prisma },
            { provide: PasswordResetLinkSender, useValue: sender },
            { provide: AuthSessionService, useValue: sessions },
            { provide: ConfigService, useValue: { get: () => APP_URL } },
          ],
        }).compile();
      } finally {
        process.env.APP_ENV = before;
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('발송기'));
    });

    it('발송에 실패하면 방금 만든 링크를 지우고 503 — 바로 다시 보낼 때 1분 제한에 걸리지 않게', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.passwordResetLink.deleteMany).toHaveBeenCalledWith({
        where: { passwordResetLinkId: 41 },
      });
    });

    it('발송에 실패하면 잠시 뒤 다시 보내라고 알린다', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toBe(
        '재설정 링크를 보내지 못했습니다. 잠시 뒤에 다시 보내 주세요.',
      );
    });

    it('보내기 전에 막히면(템플릿 꺼짐 · DB) 링크를 지우고 안내가 있는 500 — 「잠시 뒤에 다시」가 아니다', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('template off'));
      await expect(service.issue(31, 5)).rejects.toThrow(
        new InternalServerErrorException(
          '메일 설정 문제로 재설정 링크를 보내지 못했습니다. 플랫폼 관리자에게 문의해 주세요.',
        ),
      );
      expect(prisma.passwordResetLink.deleteMany).toHaveBeenCalledWith({
        where: { passwordResetLinkId: 41 },
      });
    });

    it('발송 실패 로그에 SMTP 원문을 싣지 않는다 — 받는 주소가 섞인다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      sender.send.mockRejectedValue(
        new Error('smtp 550 mailbox unavailable <staff@example.com>'),
      );
      await thrown(service.issue(31, 5));
      expect(JSON.stringify(error.mock.calls)).not.toContain(
        'staff@example.com',
      );
    });

    it('발송 실패 로그에는 토큰이 없다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      await thrown(service.issue(31, 5));
      const token = tokenOf(sentLink());
      for (const call of error.mock.calls)
        expect(call.map(String).join(' ')).not.toContain(token);
    });

    it('발송 실패 원인은 지우기보다 먼저 남긴다 — 지우기까지 실패해도 원인이 묻히지 않고 503 이다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      error.mockClear();
      sender.send.mockRejectedValue(new Error('smtp down'));
      prisma.passwordResetLink.deleteMany.mockRejectedValue(
        new Error('db down'),
      );
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const messages = error.mock.calls.map((call) => String(call[0]));
      expect(messages[0]).toContain('발송 실패');
      expect(messages.some((m) => m.includes('지우지 못했다'))).toBe(true);
      expect(error.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.passwordResetLink.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('잠금 안에서 탈퇴를 다시 본다 — 잠그기 전 사이에 탈퇴했으면 409 이고 아무것도 바꾸지 않는다', async () => {
      tx.account.findUniqueOrThrow.mockResolvedValue({ status: 'WITHDRAWN' });
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(tx.passwordResetLink.create).not.toHaveBeenCalled();
      expect(tx.passwordResetPin.updateMany).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('잠금 안에서 퇴직을 다시 본다 — 잠그기 전 사이에 퇴직 처리됐으면 409', async () => {
      tx.staffMember.findUniqueOrThrow.mockResolvedValue({
        employmentStatus: 'RETIRED',
      });
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(tx.passwordResetLink.create).not.toHaveBeenCalled();
    });
  });
  const linkRow = (over: Record<string, unknown> = {}) => ({
    passwordResetLinkId: 41,
    accountId: 7,
    requestedBy: 31,
    closedAt: null,
    expiresAt: at(HOUR),
    account: { email: 'staff@example.com', status: 'JOINED' },
    ...over,
  });

  describe('확인', () => {
    it('쓸 수 있는 링크면 204 — 아무것도 바꾸지 않는다', async () => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(linkRow());
      await expect(service.verify('tok')).resolves.toBeUndefined();
      expect(prisma.passwordResetLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashToken('tok') } }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['없는 토큰', null],
      ['닫힌 링크(사용 · 대체)', linkRow({ closedAt: at(-MINUTE) })],
      ['만료된 링크', linkRow({ expiresAt: at(-1) })],
      ['만료 시각과 같은 순간', linkRow({ expiresAt: now })],
      [
        '탈퇴한 계정',
        linkRow({
          account: { email: 'staff@example.com', status: 'WITHDRAWN' },
        }),
      ],
    ])('%s 는 사유를 가리지 않고 같은 401', async (_, row) => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(row);
      const error = await thrown(service.verify('tok'));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.message).toBe(
        '쓸 수 없는 링크입니다. 관리자에게 다시 청하거나 비밀번호 찾기로 인증번호를 받아 다시 정해 주세요.',
      );
    });
  });

  describe('새 비밀번호 저장', () => {
    beforeEach(() => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(linkRow());
      tx.passwordResetLink.findUnique.mockResolvedValue(linkRow());
    });

    it('링크를 잠금 안에서 다시 읽고 새 비밀번호를 적용한다 — 관리자 초기화 · 요청 관리자로 남긴다', async () => {
      await expect(service.reset('tok', NEW_PASSWORD)).resolves.toBeUndefined();
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 7 },
        data: {
          passwordHash: `hash:${NEW_PASSWORD}`,
          failedLoginCount: 0,
          lockExpiresAt: null,
        },
      });
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null },
        data: { closedAt: now },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
      expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx);
      expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
        data: {
          accountId: 7,
          field: 'PASSWORD',
          channel: 'ADMIN_RESET',
          requestedBy: 31,
        },
      });
    });

    it('비밀번호 해시는 잠금을 잡기 전에 만든다 — 잠금 안에서 scrypt 로 줄 서지 않게', async () => {
      await service.reset('tok', NEW_PASSWORD);
      expect(hashPasswordMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    it('규칙에 어긋나면 400 과 사유 — 링크는 닫지 않아 다시 정할 수 있다', async () => {
      const error = await thrown(service.reset('tok', 'short'));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(tx.passwordResetLink.updateMany).not.toHaveBeenCalled();
    });

    it('기다리는 사이 닫힌 링크면 규칙 사유가 아니라 401 — 닫힌 링크에 「링크는 맞다」고 답하지 않게', async () => {
      tx.passwordResetLink.findUnique.mockResolvedValue(
        linkRow({ closedAt: at(-1) }),
      );
      await expect(service.reset('tok', 'short')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(service.reset('tok', NEW_PASSWORD)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('잠금 안에서 링크 행이 없으면 500 이 아니라 401', async () => {
      tx.passwordResetLink.findUnique.mockResolvedValue(null);
      await expect(service.reset('tok', NEW_PASSWORD)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('잠금 밖에서 이미 쓸 수 없는 링크면 401 이고 트랜잭션을 열지 않는다', async () => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(null);
      await expect(service.reset('tok', NEW_PASSWORD)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('계정 행을 잠근 뒤 링크를 다시 읽는다 — 같은 링크로 동시에 두 번 정하지 못하게', async () => {
      await service.reset('tok', NEW_PASSWORD);
      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetLink.findUnique.mock.invocationCallOrder[0],
      );
    });
  });
});
