import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { PasswordResetPinSender } from './password-reset-pin-sender';
import { PasswordResetService } from './password-reset.service';

// 해시를 읽을 수 있는 가짜로 바꾼다. 진짜 scrypt 는 느리고, 여기서 보려는 것은 규칙이다.
jest.mock('./password', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
  // 어떤 핀과도 맞지 않는 값. 아래 verifyPassword 가짜는 `hash:<원문>` 만 맞다고 본다.
  dummyPasswordHash: () => Promise.resolve('dummy'),
}));

const hashPasswordMock = hashPassword as jest.Mock;
const verifyPasswordMock = verifyPassword as jest.Mock;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('PasswordResetService', () => {
  const now = new Date('2026-10-08T03:00:00.000Z');
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  let service: PasswordResetService;
  let prisma: {
    account: { findUnique: jest.Mock };
    passwordResetPin: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    passwordResetPin: {
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    account: { update: jest.Mock; findUniqueOrThrow: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sender: { send: jest.Mock; isAvailable: jest.Mock };
  let sessions: { revokeAll: jest.Mock };

  const account = (overrides: Record<string, unknown> = {}) => ({
    accountId: 7,
    email: 'staff@example.com',
    realName: '홍길동',
    status: 'JOINED',
    ...overrides,
  });
  const pinRow = (overrides: Record<string, unknown> = {}) => ({
    passwordResetPinId: 21,
    accountId: 7,
    pinHash: 'hash:AB12CD',
    issuedAt: at(-MINUTE),
    expiresAt: at(9 * MINUTE),
    attemptCount: 0,
    usedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    hashPasswordMock
      .mockReset()
      .mockImplementation((plain: string) => Promise.resolve(`hash:${plain}`));
    verifyPasswordMock
      .mockReset()
      .mockImplementation((plain: string, stored: string) =>
        Promise.resolve(stored === `hash:${plain}`),
      );
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      passwordResetPin: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      account: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'JOINED' }),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      account: { findUnique: jest.fn().mockResolvedValue(account()) },
      // 잠금 밖에서 읽는 후보와 잠금 안에서 다시 읽는 행이 같은 목을 쓴다. 둘이 달라지는 경우는
      // 그 테스트에서 mockResolvedValueOnce 로 따로 준다.
      passwordResetPin: { findFirst: tx.passwordResetPin.findFirst },
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    sender = {
      send: jest.fn().mockResolvedValue(undefined),
      isAvailable: jest.fn().mockReturnValue(true),
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordResetPinSender, useValue: sender },
        { provide: AuthSessionService, useValue: sessions },
      ],
    }).compile();
    service = module.get(PasswordResetService);
  });

  afterEach(() => jest.useRealTimers());

  const createdData = () =>
    (
      tx.passwordResetPin.create.mock.calls[0] as [
        {
          data: {
            accountId: number;
            pinHash: string;
            issuedAt: Date;
            expiresAt: Date;
          };
        },
      ]
    )[0].data;
  const sentPin = () => (sender.send.mock.calls[0] as [unknown, string])[1];

  describe('requestPin — 핀 발급', () => {
    it('핀을 만들어 해시로 저장하고 10분 뒤 만료로 둔다', async () => {
      await service.requestPin('staff@example.com');

      expect(createdData()).toMatchObject({
        accountId: 7,
        issuedAt: now,
        expiresAt: at(10 * MINUTE),
      });
      expect(createdData().pinHash).toBe(`hash:${sentPin()}`);
    });

    it('핀 원문은 발송기에만 넘기고 DB 에는 해시만 남긴다', async () => {
      await service.requestPin('staff@example.com');

      expect(sentPin()).toMatch(/^[A-Z0-9]{6}$/);
      expect(
        JSON.stringify(tx.passwordResetPin.create.mock.calls),
      ).not.toContain(`"${sentPin()}"`);
    });

    it('받는 사람과 만료 시각을 발송기에 넘긴다', async () => {
      await service.requestPin('staff@example.com');

      expect(sender.send).toHaveBeenCalledWith(
        { accountId: 7, email: 'staff@example.com', realName: '홍길동' },
        expect.stringMatching(/^[A-Z0-9]{6}$/),
        at(10 * MINUTE),
      );
    });

    it('이메일의 공백과 대소문자를 정리해 계정을 찾는다', async () => {
      await service.requestPin('  Staff@Example.COM ');

      expect(prisma.account.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'staff@example.com' } }),
      );
    });

    it('새 핀을 내면 이전의 닫히지 않은 핀을 모두 무효로 한다', async () => {
      await service.requestPin('staff@example.com');

      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
      // 무효로 한 뒤에 새 핀을 만든다.
      expect(
        tx.passwordResetPin.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.passwordResetPin.create.mock.invocationCallOrder[0]);
    });

    it('계정 행을 잠그고 판단한다 — 동시에 여러 번 눌러도 간격과 횟수가 지켜지게', async () => {
      await service.requestPin('staff@example.com');

      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetPin.create.mock.invocationCallOrder[0],
      );
    });

    describe('계정이 없을 때', () => {
      it('없는 이메일은 저장도 발송도 하지 않고, 있을 때와 똑같이 끝난다', async () => {
        prisma.account.findUnique.mockResolvedValue(null);

        await expect(
          service.requestPin('none@example.com'),
        ).resolves.toBeUndefined();

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(sender.send).not.toHaveBeenCalled();
      });

      it('없는 이메일에도 핀 해시를 만든다 — 걸린 시간으로 가입 여부를 알 수 없게', async () => {
        prisma.account.findUnique.mockResolvedValue(null);

        await service.requestPin('none@example.com');

        expect(hashPasswordMock).toHaveBeenCalledTimes(1);
      });

      it('탈퇴한 계정은 없는 계정으로 다룬다', async () => {
        prisma.account.findUnique.mockResolvedValue(
          account({ status: 'WITHDRAWN' }),
        );

        await service.requestPin('staff@example.com');

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(sender.send).not.toHaveBeenCalled();
      });

      it('연결이 보류된 계정은 핀을 받는다', async () => {
        prisma.account.findUnique.mockResolvedValue(
          account({ status: 'LINK_HOLD' }),
        );

        await service.requestPin('staff@example.com');

        expect(sender.send).toHaveBeenCalledTimes(1);
      });
    });

    describe('발급 간격과 횟수', () => {
      it('직전 발급 뒤 1분이 지나기 전에는 새 핀을 내지 않는다 — 앞서 낸 핀이 그대로 유효하다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue({
          issuedAt: at(-(MINUTE - 1)),
        });

        await service.requestPin('staff@example.com');

        expect(tx.passwordResetPin.create).not.toHaveBeenCalled();
        expect(tx.passwordResetPin.updateMany).not.toHaveBeenCalled();
        expect(sender.send).not.toHaveBeenCalled();
      });

      it('정확히 1분이 지났으면 낸다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue({
          issuedAt: at(-MINUTE),
        });

        await service.requestPin('staff@example.com');

        expect(sender.send).toHaveBeenCalledTimes(1);
      });

      it('가장 최근에 낸 핀을 기준으로 본다', async () => {
        await service.requestPin('staff@example.com');

        expect(tx.passwordResetPin.findFirst).toHaveBeenCalledWith({
          where: { accountId: 7 },
          orderBy: { issuedAt: 'desc' },
          select: { issuedAt: true },
        });
      });

      it('24시간 안에 10번 냈으면 더 내지 않는다', async () => {
        tx.passwordResetPin.count.mockResolvedValue(10);

        await service.requestPin('staff@example.com');

        expect(tx.passwordResetPin.create).not.toHaveBeenCalled();
        expect(sender.send).not.toHaveBeenCalled();
      });

      it('하루 한도에 걸리면 응답은 같지만 서버에는 남긴다 — 메일이 안 온다는 문의나 남의 메일함 폭격을 추적할 수 있게', async () => {
        tx.passwordResetPin.count.mockResolvedValue(10);
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await expect(
          service.requestPin('staff@example.com'),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('accountId=7'),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          'staff@example.com',
        );
        warn.mockRestore();
      });

      it('9번까지는 낸다', async () => {
        tx.passwordResetPin.count.mockResolvedValue(9);

        await service.requestPin('staff@example.com');

        expect(sender.send).toHaveBeenCalledTimes(1);
      });

      it('횟수는 이미 무효가 된 핀까지 24시간 단위로 센다', async () => {
        await service.requestPin('staff@example.com');

        expect(tx.passwordResetPin.count).toHaveBeenCalledWith({
          where: { accountId: 7, issuedAt: { gte: at(-DAY) } },
        });
      });
    });

    it('발송에 실패해도 던지지 않는다 — 던지면 계정이 있다는 사실이 드러난다', async () => {
      sender.send.mockRejectedValue(new Error('smtp down'));
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(
        service.requestPin('staff@example.com'),
      ).resolves.toBeUndefined();
      await Promise.resolve();
      await Promise.resolve();

      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });

    it('발송이 끝나기를 기다리지 않는다 — 기다리면 발송 시간만큼 늦어져 계정이 있다는 것이 드러난다', async () => {
      sender.send.mockReturnValue(new Promise(() => undefined));

      await expect(
        service.requestPin('staff@example.com'),
      ).resolves.toBeUndefined();
      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        '요청 오류',
        new Prisma.PrismaClientKnownRequestError('deadlock', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ],
      [
        '알 수 없는 요청 오류',
        new Prisma.PrismaClientUnknownRequestError('unknown', {
          clientVersion: 'test',
        }),
      ],
      [
        '연결 실패',
        new Prisma.PrismaClientInitializationError('db down', 'test'),
      ],
    ])(
      '저장 중 DB 오류(%s)는 남기고 204 로 끝낸다 — 계정이 있을 때만 500 이 되면 가입 여부가 드러난다',
      async (_, error) => {
        prisma.$transaction.mockRejectedValue(error);
        const logged = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        await expect(
          service.requestPin('staff@example.com'),
        ).resolves.toBeUndefined();

        expect(logged).toHaveBeenCalled();
        expect(sender.send).not.toHaveBeenCalled();
        logged.mockRestore();
      },
    );

    describe('발송기를 쓸 수 없을 때', () => {
      beforeEach(() => sender.isAvailable.mockReturnValue(false));

      it('계정과 상관없이 503 이다 — 핀이 나가지 않는데 204 로 "보냈다"고 답하지 않는다', async () => {
        await expect(
          service.requestPin('staff@example.com'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        prisma.account.findUnique.mockResolvedValue(null);
        await expect(
          service.requestPin('none@example.com'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
      });

      it('계정을 찾기 전에 거부한다 — 계정 유무로 응답이 갈리지 않게', async () => {
        await service.requestPin('staff@example.com').catch(() => undefined);

        expect(prisma.account.findUnique).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    it('발송은 저장이 끝난 뒤에 한다 — 저장에 실패했는데 핀이 나가면 안 된다', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));

      await expect(service.requestPin('staff@example.com')).rejects.toThrow(
        'db down',
      );

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('verifyPin — 핀 확인', () => {
    const INVALID = '핀이 올바르지 않거나 만료되었습니다';

    beforeEach(() => {
      tx.passwordResetPin.findFirst.mockResolvedValue(pinRow());
    });

    it('맞는 핀이면 통과하고 아무것도 바꾸지 않는다', async () => {
      await expect(
        service.verifyPin('staff@example.com', 'AB12CD'),
      ).resolves.toBeUndefined();

      expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('앞뒤 공백과 소문자를 받아 준다', async () => {
      await expect(
        service.verifyPin('staff@example.com', ' ab12cd '),
      ).resolves.toBeUndefined();
    });

    it('가장 최근의 닫히지 않은 핀만 본다', async () => {
      await service.verifyPin('staff@example.com', 'AB12CD');

      expect(tx.passwordResetPin.findFirst).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        orderBy: { issuedAt: 'desc' },
      });
    });

    it('계정 행을 잠그고 다시 읽는다 — 틀린 시도가 동시에 와도 5회를 넘기지 못하게', async () => {
      await service.verifyPin('staff@example.com', 'AB12CD');

      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.passwordResetPin.findFirst).toHaveBeenCalledTimes(2);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetPin.findFirst.mock.invocationCallOrder[1],
      );
    });

    it('핀 검증(scrypt)은 잠금을 잡기 전에 한다 — 잠근 채 30ms 를 쓰면 같은 계정의 요청이 줄을 선다', async () => {
      await service.verifyPin('staff@example.com', 'AB12CD');

      expect(verifyPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    describe('잠금을 기다리는 사이 바뀌었을 때', () => {
      it('그 사이 탈퇴했으면 맞는 핀도 거부하고 횟수도 올리지 않는다 — 탈퇴는 없는 계정과 같다', async () => {
        tx.account.findUniqueOrThrow.mockResolvedValue({ status: 'WITHDRAWN' });

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
          service.resetPassword('staff@example.com', 'AB12CD', 'Brand-new-pw1'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('그 사이 새 핀이 나왔으면 맞았던 핀도 거부하고 새 핀의 횟수도 올리지 않는다', async () => {
        tx.passwordResetPin.findFirst
          .mockResolvedValueOnce(pinRow())
          .mockResolvedValueOnce(
            pinRow({ passwordResetPinId: 22, pinHash: 'hash:QQ99QQ' }),
          );

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
      });

      it('그 사이 다른 시도로 5회가 찼으면 맞는 핀도 거부한다', async () => {
        tx.passwordResetPin.findFirst
          .mockResolvedValueOnce(pinRow({ attemptCount: 4 }))
          .mockResolvedValueOnce(pinRow({ attemptCount: 5 }));

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
      });

      it('만료는 잠금을 잡은 뒤의 시각으로 본다', async () => {
        tx.$queryRaw.mockImplementation(() => {
          jest.setSystemTime(at(9 * MINUTE));
          return Promise.resolve([]);
        });

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('그 사이 다른 시도가 틀린 횟수만 올렸으면 맞는 핀은 통과한다', async () => {
        tx.passwordResetPin.findFirst
          .mockResolvedValueOnce(pinRow({ attemptCount: 1 }))
          .mockResolvedValueOnce(pinRow({ attemptCount: 3 }));

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).resolves.toBeUndefined();
      });
    });

    describe('틀렸을 때', () => {
      it('401 로 거부하고 틀린 횟수를 하나 올린다', async () => {
        await expect(
          service.verifyPin('staff@example.com', 'ZZZZZZ'),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(tx.passwordResetPin.update).toHaveBeenCalledWith({
          where: { passwordResetPinId: 21 },
          data: { attemptCount: { increment: 1 } },
        });
      });

      it('횟수를 올린 일은 거부해도 되돌려지지 않는다 — 던지는 것은 트랜잭션이 끝난 뒤다', async () => {
        const committed: string[] = [];
        prisma.$transaction.mockImplementation(
          async (work: (client: typeof tx) => unknown) => {
            const result = await work(tx);
            committed.push('commit');
            return result;
          },
        );

        await service
          .verifyPin('staff@example.com', 'ZZZZZZ')
          .catch(() => undefined);

        expect(committed).toEqual(['commit']);
        expect(tx.passwordResetPin.update).toHaveBeenCalledTimes(1);
      });

      it('5번째로 틀려 핀이 닫히면 서버에 남긴다 — 핀 대입 시도를 추적할 수 있게, 핀 값은 남기지 않는다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ attemptCount: 4 }),
        );
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await service
          .verifyPin('staff@example.com', 'ZZZZZZ')
          .catch(() => undefined);

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('accountId=7'),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('ZZZZZZ');
        warn.mockRestore();
      });

      it('닫힐 만큼 틀리지 않았으면 남기지 않는다', async () => {
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await service
          .verifyPin('staff@example.com', 'ZZZZZZ')
          .catch(() => undefined);

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('4번 틀린 핀을 다시 틀리면 5회째로 올린다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ attemptCount: 4 }),
        );

        await service
          .verifyPin('staff@example.com', 'ZZZZZZ')
          .catch(() => undefined);

        expect(tx.passwordResetPin.update).toHaveBeenCalledTimes(1);
      });
    });

    describe('거부해야 할 핀', () => {
      it('5회 틀려 닫힌 핀은 맞는 값이어도 거부하고 더 세지도 않는다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ attemptCount: 5 }),
        );

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
      });

      it('만료 시각이 지난 핀은 맞는 값이어도 거부한다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ expiresAt: at(-1) }),
        );

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('만료 시각과 정확히 같은 순간도 만료다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ expiresAt: at(0) }),
        );

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('살아 있는 핀이 없으면 거부한다 — 모두 무효가 됐거나 낸 적이 없음', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(null);

        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('없는 계정과 탈퇴한 계정도 거부한다', async () => {
        prisma.account.findUnique.mockResolvedValue(null);
        await expect(
          service.verifyPin('none@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        prisma.account.findUnique.mockResolvedValue(
          account({ status: 'WITHDRAWN' }),
        );
        await expect(
          service.verifyPin('staff@example.com', 'AB12CD'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });
    });

    it('어떤 이유로 거부해도 메시지가 같다 — 틀림·만료·닫힘·없음을 구분해 알리지 않는다', async () => {
      const messages: string[] = [];
      const fail = async () =>
        service
          .verifyPin('staff@example.com', 'ZZZZZZ')
          .catch((e: UnauthorizedException) => messages.push(e.message));

      await fail(); // 틀림
      tx.passwordResetPin.findFirst.mockResolvedValue(
        pinRow({ expiresAt: at(-1) }),
      );
      await fail(); // 만료
      tx.passwordResetPin.findFirst.mockResolvedValue(
        pinRow({ attemptCount: 5 }),
      );
      await fail(); // 닫힘
      tx.passwordResetPin.findFirst.mockResolvedValue(null);
      await fail(); // 없음
      prisma.account.findUnique.mockResolvedValue(null);
      await fail(); // 없는 계정

      expect(new Set(messages)).toEqual(new Set([INVALID]));
      expect(messages).toHaveLength(5);
    });

    it('핀을 검증할 수 없는 경우에도 비밀번호 검증을 한 번 돌려 시간을 맞춘다', async () => {
      tx.passwordResetPin.findFirst.mockResolvedValue(null);

      await service
        .verifyPin('staff@example.com', 'AB12CD')
        .catch(() => undefined);
      expect(verifyPasswordMock).toHaveBeenCalledTimes(1);

      verifyPasswordMock.mockClear();
      prisma.account.findUnique.mockResolvedValue(null);
      await service
        .verifyPin('none@example.com', 'AB12CD')
        .catch(() => undefined);
      expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetPassword — 새 비밀번호', () => {
    const NEW_PASSWORD = 'Brand-new-pw1';

    beforeEach(() => {
      tx.passwordResetPin.findFirst.mockResolvedValue(pinRow());
    });

    const reset = (pin = 'AB12CD', password = NEW_PASSWORD) =>
      service.resetPassword('staff@example.com', pin, password);

    it('맞는 핀이면 비밀번호를 해시로 바꾸고 실패 횟수와 잠금을 지운다', async () => {
      await reset();

      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 7 },
        data: {
          passwordHash: `hash:${NEW_PASSWORD}`,
          failedLoginCount: 0,
          lockExpiresAt: null,
        },
      });
    });

    it('핀을 소진한다', async () => {
      await reset();

      expect(tx.passwordResetPin.update).toHaveBeenCalledWith({
        where: { passwordResetPinId: 21 },
        data: { usedAt: now },
      });
    });

    it('모든 기기의 접속 상태를 같은 트랜잭션에서 끊는다', async () => {
      await reset();

      expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx);
    });

    it('새 비밀번호 해시는 잠금을 잡기 전에 만든다', async () => {
      await reset();

      expect(hashPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    it('변경 이력에 본인 핀 재설정으로 남기고 비밀번호 값은 남기지 않는다', async () => {
      await reset();

      expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
        data: { accountId: 7, field: 'PASSWORD', channel: 'PIN_RESET' },
      });
    });

    it('앞뒤 공백과 소문자 핀을 받아 준다', async () => {
      await expect(reset(' ab12cd ')).resolves.toBeUndefined();
    });

    describe('핀이 틀렸거나 쓸 수 없을 때', () => {
      it('401 로 거부하고 아무것도 바꾸지 않으며 틀린 횟수를 하나 올린다', async () => {
        await expect(reset('ZZZZZZ')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );

        expect(tx.account.update).not.toHaveBeenCalled();
        expect(sessions.revokeAll).not.toHaveBeenCalled();
        expect(tx.accountChangeHistory.create).not.toHaveBeenCalled();
        expect(tx.passwordResetPin.update).toHaveBeenCalledWith({
          where: { passwordResetPinId: 21 },
          data: { attemptCount: { increment: 1 } },
        });
      });

      it('핀 확인과 같은 5회에 합산된다 — 5회 틀려 닫힌 핀은 맞아도 바꾸지 못한다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ attemptCount: 5 }),
        );

        await expect(reset()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('만료된 핀으로는 바꾸지 못한다 — 10분 안에 비밀번호를 정하지 못하면 그대로 만료', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(
          pinRow({ expiresAt: at(0) }),
        );

        await expect(reset()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('이미 쓴 핀이나 새 핀으로 대체된 핀으로는 바꾸지 못한다', async () => {
        tx.passwordResetPin.findFirst.mockResolvedValue(null);

        await expect(reset()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('없는 계정과 탈퇴한 계정은 바꾸지 못한다', async () => {
        prisma.account.findUnique.mockResolvedValue(
          account({ status: 'WITHDRAWN' }),
        );

        await expect(reset()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('새 비밀번호가 규칙에 어긋날 때', () => {
      it('400 과 사유를 주고 아무것도 바꾸지 않는다', async () => {
        const error: unknown = await reset('AB12CD', 'short').catch(
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message.length).toBeGreaterThan(5);
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('핀은 소진하지 않고 틀린 횟수도 올리지 않는다 — 다시 정할 수 있어야 한다', async () => {
        await reset('AB12CD', 'short').catch(() => undefined);

        expect(tx.passwordResetPin.update).not.toHaveBeenCalled();
        expect(sessions.revokeAll).not.toHaveBeenCalled();
        expect(hashPasswordMock).not.toHaveBeenCalled();
      });

      it('잠금을 기다리는 사이 핀이 닫혔으면 규칙 위반보다 핀 거부가 먼저다 — 닫힌 핀으로 "핀은 맞다"는 답을 주지 않는다', async () => {
        tx.passwordResetPin.findFirst
          .mockResolvedValueOnce(pinRow({ attemptCount: 4 }))
          .mockResolvedValueOnce(pinRow({ attemptCount: 5 }));

        await expect(reset('AB12CD', 'short')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      });

      it('규칙 위반도 잠금 안에서 핀을 다시 확인한 뒤에 답한다', async () => {
        await reset('AB12CD', 'short').catch(() => undefined);

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.passwordResetPin.findFirst).toHaveBeenCalledTimes(2);
      });

      it('이메일을 그대로 쓴 비밀번호는 받지 않는다', async () => {
        await expect(
          reset('AB12CD', 'staff@example.com'),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('핀이 틀렸으면 규칙보다 핀 거부가 먼저다 — 규칙을 알아내는 통로가 되지 않게', async () => {
        await expect(reset('ZZZZZZ', 'short')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      });
    });
  });
});
