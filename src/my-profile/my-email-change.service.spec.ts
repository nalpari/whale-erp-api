import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../auth/password';
import * as mailService from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailChangePinSender } from './email-change-pin-sender';
import {
  EMAIL_IN_USE_MESSAGE,
  INVALID_EMAIL_CHANGE_PIN_MESSAGE,
  MyEmailChangeService,
} from './my-email-change.service';

const NOW = new Date('2026-10-20T05:00:00Z');
/** MailService 가 SMTP 단계에서 던진 것으로 표시한 오류 */
const smtpErrors = new WeakSet<object>();
/** 환경 변수를 되돌린다 — 원래 없었으면 지운다(대입하면 문자열 'undefined' 가 들어간다) */
const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
const smtpError = (message = 'smtp') => {
  const e = new Error(message);
  smtpErrors.add(e);
  return e;
};
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('MyEmailChangeService', () => {
  let pinHash: string;
  let tx: {
    $queryRaw: jest.Mock;
    account: {
      findUniqueOrThrow: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    emailChangePin: {
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    accountChangeHistory: { create: jest.Mock };
    passwordResetPin: { updateMany: jest.Mock };
    passwordResetLink: { updateMany: jest.Mock };
  };
  let sender: { isAvailable: jest.Mock; send: jest.Mock };

  beforeAll(async () => {
    pinHash = await hashPassword('A7K2Q9');
  });
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    jest
      .spyOn(mailService, 'isMailTransportError')
      .mockImplementation(
        (e: unknown) =>
          typeof e === 'object' && e !== null && smtpErrors.has(e),
      );
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const pinRow = (patch: Record<string, unknown> = {}) => ({
    emailChangePinId: 3,
    newEmail: 'new@example.com',
    pinHash,
    issuedAt: NOW,
    expiresAt: minutes(15),
    attemptCount: 0,
    usedAt: null,
    ...patch,
  });

  const build = async () => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ email: 'old@example.com', status: 'JOINED' }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      emailChangePin: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ emailChangePinId: 8 }),
        update: jest.fn().mockResolvedValue({}),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
      passwordResetPin: { updateMany: jest.fn().mockResolvedValue({}) },
      passwordResetLink: { updateMany: jest.fn().mockResolvedValue({}) },
    };
    // 트랜잭션 밖 읽기도 같은 모의 객체를 쓴다 — 잠금 전후로 같은 값이 보이는 보통의 경우
    const prisma = {
      ...tx,
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    sender = {
      isAvailable: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyEmailChangeService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailChangePinSender, useValue: sender },
      ],
    }).compile();
    return moduleRef.get(MyEmailChangeService);
  };

  describe('기동', () => {
    it('운영에서 메일을 보낼 수 없으면 기동 때 error 로 남긴다 — 직원이 첫 503 을 받기 전에 배포 로그에서 알게', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const before = process.env.APP_ENV;
      process.env.APP_ENV = 'prod';
      try {
        new MyEmailChangeService(
          {} as PrismaService,
          { isAvailable: () => false } as unknown as EmailChangePinSender,
        );
      } finally {
        restoreEnv('APP_ENV', before);
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('MAIL_*'));
    });

    it('운영이 아니면 남기지 않는다', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const before = { app: process.env.APP_ENV, node: process.env.NODE_ENV };
      process.env.APP_ENV = 'local';
      process.env.NODE_ENV = 'test';
      try {
        new MyEmailChangeService(
          {} as PrismaService,
          { isAvailable: () => false } as unknown as EmailChangePinSender,
        );
      } finally {
        restoreEnv('APP_ENV', before.app);
        restoreEnv('NODE_ENV', before.node);
      }
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('핀 요청', () => {
    it('계정을 잠그고 새 이메일 · 핀 해시 · 15분 만료로 저장한 뒤(커밋 뒤) 새 이메일로 원문 핀을 보내고, 보낸 다음에야 앞선 핀을 닫는다', async () => {
      const service = await build();
      await service.requestPin(12, ' New@Example.com ');

      expect(tx.$queryRaw).toHaveBeenCalled();
      // 이번 핀보다 앞서 낸 열린 핀만 — 보내는 사이 새로 낸 핀은 닫지 않는다
      expect(tx.emailChangePin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 12, usedAt: null, issuedAt: { lt: NOW } },
        data: { usedAt: NOW },
      });
      const [createdAt] = tx.emailChangePin.create.mock.invocationCallOrder;
      const [sentAt] = sender.send.mock.invocationCallOrder;
      const [closedAt] = tx.emailChangePin.updateMany.mock.invocationCallOrder;
      expect(createdAt).toBeLessThan(sentAt);
      expect(sentAt).toBeLessThan(closedAt);
      // 저장과 닫기는 서로 다른 트랜잭션이다 — 메일을 기다리는 동안 트랜잭션도 계정 행 잠금도 쥐지 않는다
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      const { data } = (
        tx.emailChangePin.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0];
      expect(data).toMatchObject({
        accountId: 12,
        newEmail: 'new@example.com',
        issuedAt: NOW,
        expiresAt: minutes(15),
      });
      expect(data.pinHash).toMatch(/^scrypt\$/);
      const [to, pin] = sender.send.mock.calls[0] as [string, string];
      expect(to).toBe('new@example.com');
      expect(pin).toMatch(/^[A-Z0-9]{6}$/);
      expect(data.pinHash).not.toContain(pin);
    });

    it('메일을 보낼 수 없으면 503 이고 저장하지 않는다', async () => {
      const service = await build();
      sender.isAvailable.mockReturnValue(false);
      await expect(
        service.requestPin(12, 'new@example.com'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(tx.emailChangePin.create).not.toHaveBeenCalled();
    });

    it('SMTP 가 실패하면 이번 핀을 지우고 503 — 1분 기다리지 않고 다시 받는다. 앞선 핀은 닫지 않는다', async () => {
      const service = await build();
      sender.send.mockRejectedValue(smtpError());
      await expect(
        service.requestPin(12, 'new@example.com'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(tx.emailChangePin.deleteMany).toHaveBeenCalledWith({
        where: { emailChangePinId: 8 },
      });
      expect(tx.emailChangePin.updateMany).not.toHaveBeenCalled();
    });

    it('보내기 전에 막히면(템플릿 꺼짐 · DB) 핀을 지우고 안내가 있는 500 — 「잠시 뒤에 다시」가 아니다. 로그에는 오류 이름만', async () => {
      const service = await build();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      sender.send.mockRejectedValue(new TypeError('template off <a@b.c>'));
      await expect(service.requestPin(12, 'new@example.com')).rejects.toThrow(
        new InternalServerErrorException(
          '메일 설정 문제로 인증 메일을 보내지 못했습니다. 관리자에게 문의해 주세요',
        ),
      );
      expect(tx.emailChangePin.deleteMany).toHaveBeenCalled();
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('TypeError');
      expect(logged).not.toContain('a@b.c');
    });

    it('실패 로그에 SMTP 원문을 싣지 않는다 — 받는 주소가 섞인다', async () => {
      const service = await build();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      sender.send.mockRejectedValue(
        smtpError('550 mailbox unavailable <new@example.com>'),
      );
      await service.requestPin(12, 'new@example.com').catch(() => undefined);
      expect(JSON.stringify(error.mock.calls)).not.toContain('new@example.com');
      error.mockRestore();
    });

    it('지우기마저 실패해도 503 이다 — 원인을 먼저, 지우지 못한 핀 id 를 따로 남긴다. 남은 핀은 다음 발급이 닫는다', async () => {
      const service = await build();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      sender.send.mockRejectedValue(smtpError());
      tx.emailChangePin.deleteMany.mockRejectedValue(new Error('db'));
      await expect(
        service.requestPin(12, 'new@example.com'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const messages = error.mock.calls.map((call) => String(call[0]));
      expect(messages[0]).toContain('발송 실패');
      expect(
        messages.some(
          (m) =>
            m.includes('지우지 못했다') && m.includes('emailChangePinId=8'),
        ),
      ).toBe(true);
    });

    it('보낸 뒤 앞선 핀 닫기가 실패해도 204 — 메일은 이미 나갔고, 확인은 가장 새 핀만 본다', async () => {
      const service = await build();
      tx.emailChangePin.updateMany.mockRejectedValue(new Error('db'));
      await expect(
        service.requestPin(12, 'new@example.com'),
      ).resolves.toBeUndefined();
    });

    it('지금 이메일과 같으면 400', async () => {
      const service = await build();
      await expect(
        service.requestPin(12, 'OLD@example.com'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('다른 계정이 쓰는 이메일이면 409 — 이메일은 계정에 하나뿐이다', async () => {
      const service = await build();
      tx.account.findUnique.mockResolvedValue({ accountId: 99 });
      await expect(service.requestPin(12, 'new@example.com')).rejects.toThrow(
        new ConflictException(EMAIL_IN_USE_MESSAGE),
      );
      expect(tx.account.findUnique).toHaveBeenCalledWith({
        where: { email: 'new@example.com' },
        select: { accountId: true },
      });
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('직전 핀에서 1분이 안 지났으면 429 이고 새 핀을 내지 않는다', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue({
        issuedAt: new Date(NOW.getTime() - 59_000),
      });
      const error = await service
        .requestPin(12, 'new@example.com')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(tx.emailChangePin.create).not.toHaveBeenCalled();
    });

    it('24시간에 10번 냈으면 429', async () => {
      const service = await build();
      tx.emailChangePin.count.mockResolvedValue(10);
      const error = await service
        .requestPin(12, 'new@example.com')
        .catch((e: unknown) => e);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(tx.emailChangePin.count).toHaveBeenCalledWith({
        where: { accountId: 12, issuedAt: { gte: minutes(-24 * 60) } },
      });
    });

    it('탈퇴 계정은 401', async () => {
      const service = await build();
      tx.account.findUniqueOrThrow.mockResolvedValue({
        email: 'old@example.com',
        status: 'WITHDRAWN',
      });
      await expect(
        service.requestPin(12, 'new@example.com'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('핀 확인 → 변경', () => {
    it('맞으면 계정 이메일을 새 이메일로 바꾸고, 핀을 쓴 것으로 닫고, 전후 값을 본인 이력으로 남긴다', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      await service.confirm(12, ' a7k2q9 ');

      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 12 },
        data: { email: 'new@example.com' },
      });
      // 쓴 핀을 포함해 그 계정의 열린 핀을 모두 닫는다
      expect(tx.emailChangePin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 12, usedAt: null },
        data: { usedAt: NOW },
      });
      expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
        data: {
          accountId: 12,
          field: 'EMAIL',
          channel: 'SELF',
          beforeValue: 'old@example.com',
          afterValue: 'new@example.com',
        },
      });
    });

    it('바꾸면 그 계정의 열린 이메일 변경 핀을 모두 닫는다 — 앞선 핀 닫기가 실패했어도 다른 주소로 또 바뀌지 않게', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      await service.confirm(12, 'A7K2Q9');
      expect(tx.emailChangePin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 12, usedAt: null },
        data: { usedAt: NOW },
      });
    });

    it('바꾸면 옛 주소로 나간 비밀번호 재설정 핀 · 관리자 링크를 닫는다 — 옛 수신함으로 비밀번호를 바꾸지 못하게', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      await service.confirm(12, 'A7K2Q9');
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 12, usedAt: null },
        data: { usedAt: NOW },
      });
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 12, closedAt: null },
        data: { closedAt: NOW },
      });
    });

    it('틀리면 시도 횟수만 올리고 400 — 401 로 답하면 앱이 로그아웃으로 안다', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      await expect(service.confirm(12, 'ZZZZZZ')).rejects.toThrow(
        new BadRequestException(INVALID_EMAIL_CHANGE_PIN_MESSAGE),
      );
      expect(tx.emailChangePin.update).toHaveBeenCalledWith({
        where: { emailChangePinId: 3 },
        data: { attemptCount: { increment: 1 } },
      });
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it.each([
      ['핀이 없음', null],
      ['만료(만료 시각과 같은 순간 포함)', pinRow({ expiresAt: NOW })],
      ['5회 틀려 닫힘', pinRow({ attemptCount: 5 })],
    ])('%s 이면 400 이고 아무것도 바꾸지 않는다', async (_, row) => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(row);
      await expect(service.confirm(12, 'A7K2Q9')).rejects.toThrow(
        new BadRequestException(INVALID_EMAIL_CHANGE_PIN_MESSAGE),
      );
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(tx.emailChangePin.update).not.toHaveBeenCalled();
    });

    it('맞혔는데 그 사이 다른 계정이 그 이메일을 가졌으면 409 이고 핀은 그대로 둔다', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      tx.account.findUnique.mockResolvedValue({ accountId: 99 });
      await expect(service.confirm(12, 'A7K2Q9')).rejects.toThrow(
        new ConflictException(EMAIL_IN_USE_MESSAGE),
      );
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('고유 제약에 걸리면(동시에 같은 이메일로 바꿈) 409 로 답한다', async () => {
      const service = await build();
      tx.emailChangePin.findFirst.mockResolvedValue(pinRow());
      tx.account.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(service.confirm(12, 'A7K2Q9')).rejects.toThrow(
        new ConflictException(EMAIL_IN_USE_MESSAGE),
      );
    });

    it('검증한 뒤 잠금 안에서 다시 읽은 핀이 다르면(새 핀이 나옴) 결과를 버리고 400', async () => {
      const service = await build();
      tx.emailChangePin.findFirst
        .mockResolvedValueOnce(pinRow())
        .mockResolvedValueOnce(pinRow({ emailChangePinId: 4 }));
      await expect(service.confirm(12, 'A7K2Q9')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(tx.emailChangePin.update).not.toHaveBeenCalled();
    });
  });
});
