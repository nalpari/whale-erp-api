import { BadRequestException, UnauthorizedException } from '@nestjs/common';
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
}));

const hashPasswordMock = hashPassword as jest.Mock;
const verifyPasswordMock = verifyPassword as jest.Mock;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('PasswordResetService', () => {
  const now = new Date('2026-10-08T03:00:00.000Z');
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  let service: PasswordResetService;
  let prisma: { account: { findUnique: jest.Mock }; $transaction: jest.Mock };
  let tx: {
    $queryRaw: jest.Mock;
    passwordResetPin: {
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    account: { update: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sender: { send: jest.Mock };
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
      account: { update: jest.fn().mockResolvedValue({}) },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      account: { findUnique: jest.fn().mockResolvedValue(account()) },
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    sender = { send: jest.fn().mockResolvedValue(undefined) };
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

      await expect(
        service.requestPin('staff@example.com'),
      ).resolves.toBeUndefined();
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

    it('계정 행을 잠그고 읽는다 — 틀린 시도가 동시에 와도 5회를 넘기지 못하게', async () => {
      await service.verifyPin('staff@example.com', 'AB12CD');

      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetPin.findFirst.mock.invocationCallOrder[0],
      );
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
