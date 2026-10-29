import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { EmailFindService } from './email-find.service';
import { phoneKeyOf } from './phone-key';

const MINUTE = 60 * 1000;
const SECRET = 's'.repeat(48);
const PHONE = '01012345678';

describe('EmailFindService', () => {
  const now = new Date('2026-10-13T03:00:00.000Z');
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  let service: EmailFindService;
  let tx: {
    $executeRaw: jest.Mock;
    emailFindAttempt: { findFirst: jest.Mock; create: jest.Mock };
    account: { findMany: jest.Mock };
  };

  const account = (overrides: Record<string, unknown> = {}) => ({
    email: 'steelgym@gmail.com',
    realName: '홍길동',
    birthDate: new Date('1990-05-17T00:00:00.000Z'),
    ...overrides,
  });
  const input = (overrides: Record<string, unknown> = {}) => ({
    name: '홍길동',
    phone: PHONE,
    birthDate: '1990-05-17',
    ...overrides,
  });
  const lastAttempt = (failedCount: number, lockExpiresAt: Date | null) =>
    tx.emailFindAttempt.findFirst.mockResolvedValue({
      failedCount,
      lockExpiresAt,
    });
  const recorded = () =>
    (tx.emailFindAttempt.create.mock.calls[0] as [{ data: unknown }])[0].data;
  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('던지지 않았다');
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      emailFindAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      account: { findMany: jest.fn().mockResolvedValue([account()]) },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailFindService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => SECRET } },
      ],
    }).compile();
    service = module.get(EmailFindService);
  });

  afterEach(() => jest.useRealTimers());

  describe('맞을 때', () => {
    it('가린 이메일을 목록으로 돌려준다', async () => {
      await expect(service.find(input())).resolves.toEqual([
        'st*****m@gmail.com',
      ]);
    });

    it('그 번호의 탈퇴하지 않은 계정만, 가입 순서대로 찾는다', async () => {
      await service.find(input());
      expect(tx.account.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { phone: PHONE, status: { not: 'WITHDRAWN' } },
          orderBy: { accountId: 'asc' },
        }),
      );
    });

    it('맞는 계정이 여럿이면 모두 돌려주고, 이름이나 생년월일이 다른 계정은 뺀다', async () => {
      tx.account.findMany.mockResolvedValue([
        account({ email: 'first@a.com' }),
        account({ email: 'other@a.com', realName: '김철수' }),
        account({
          email: 'older@a.com',
          birthDate: new Date('1980-01-01T00:00:00.000Z'),
        }),
        account({ email: 'second@b.com' }),
      ]);
      await expect(service.find(input())).resolves.toEqual([
        'fi**t@a.com',
        'se***d@b.com',
      ]);
    });

    it('이름은 유니코드 정규형(NFC)을 맞춰 견준다 — 자모를 풀어 보내는 입력기에서도 본인이 404 를 받지 않게', async () => {
      await expect(
        service.find(input({ name: '홍길동'.normalize('NFD') })),
      ).resolves.toHaveLength(1);
      tx.account.findMany.mockResolvedValue([
        account({ realName: '홍길동'.normalize('NFD') }),
      ]);
      await expect(service.find(input())).resolves.toHaveLength(1);
    });

    it('이름은 앞뒤 공백만 무시하고 똑같아야 한다', async () => {
      tx.account.findMany.mockResolvedValue([
        account({ realName: ' 홍길동 ' }),
      ]);
      await expect(service.find(input())).resolves.toHaveLength(1);
      tx.account.findMany.mockResolvedValue([account({ realName: '홍 길동' })]);
      await expect(service.find(input())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('성공을 남기고 실패 횟수를 0으로 되돌린다 — 넣은 값 원문은 남기지 않는다', async () => {
      lastAttempt(3, null);
      await service.find(input());
      expect(recorded()).toEqual({
        phoneKey: phoneKeyOf(SECRET, PHONE),
        isSucceeded: true,
        failedCount: 0,
        lockExpiresAt: null,
        attemptedAt: now,
      });
    });

    it('번호의 계정이 여럿이면 모두 맞았을 때만 실패 횟수를 0으로 되돌린다', async () => {
      lastAttempt(3, null);
      tx.account.findMany.mockResolvedValue([
        account({ email: 'first@a.com' }),
        account({ email: 'second@b.com' }),
      ]);
      await service.find(input());
      expect(recorded()).toEqual(
        expect.objectContaining({ isSucceeded: true, failedCount: 0 }),
      );
    });

    it('일부만 맞으면 찾은 것은 주되 실패 횟수는 그대로 둔다 — 내 계정을 맞혀 남의 계정 대입 횟수를 지우지 못하게', async () => {
      lastAttempt(4, null);
      tx.account.findMany.mockResolvedValue([
        account({ email: 'mine@a.com' }),
        account({ email: 'other@b.com', realName: '김철수' }),
      ]);
      await expect(service.find(input())).resolves.toEqual(['mi*e@a.com']);
      expect(recorded()).toEqual({
        phoneKey: phoneKeyOf(SECRET, PHONE),
        isSucceeded: true,
        failedCount: 4,
        lockExpiresAt: null,
        attemptedAt: now,
      });
    });
  });

  describe('맞지 않을 때', () => {
    it.each([
      ['이름', { name: '김철수' }],
      ['생년월일', { birthDate: '1990-05-18' }],
    ])(
      '%s 이 다르면 404 이고 어느 값이 틀렸는지 알리지 않는다',
      async (_, over) => {
        const error = await thrown(service.find(input(over)));
        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe('일치하는 계정이 없습니다.');
      },
    );

    it('그 번호의 계정이 없어도 같은 404 다', async () => {
      tx.account.findMany.mockResolvedValue([]);
      const error = await thrown(service.find(input()));
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('일치하는 계정이 없습니다.');
    });

    it('실패를 한 번 센 상태를 남긴다', async () => {
      lastAttempt(2, null);
      tx.account.findMany.mockResolvedValue([]);
      await thrown(service.find(input()));
      expect(recorded()).toEqual({
        phoneKey: phoneKeyOf(SECRET, PHONE),
        isSucceeded: false,
        failedCount: 3,
        lockExpiresAt: null,
        attemptedAt: now,
      });
    });

    it('5번째 실패면 5분 막고 429 와 해제 시각을 알린다', async () => {
      lastAttempt(4, null);
      tx.account.findMany.mockResolvedValue([]);
      const error = await thrown(service.find(input()));
      expect(error.getStatus()).toBe(429);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ lockExpiresAt: at(5 * MINUTE) }),
      );
      expect(recorded()).toEqual(
        expect.objectContaining({
          failedCount: 5,
          lockExpiresAt: at(5 * MINUTE),
        }),
      );
    });

    it('이번 실패로 막히면 경고를 남긴다 — 번호 원문 없이 키 앞부분만', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      lastAttempt(4, null);
      tx.account.findMany.mockResolvedValue([]);
      await thrown(service.find(input()));
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain(phoneKeyOf(SECRET, PHONE).slice(0, 8));
      expect(message).not.toContain(PHONE);
      warn.mockRestore();
    });

    it('막히지 않은 실패는 경고하지 않는다', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      lastAttempt(3, null);
      tx.account.findMany.mockResolvedValue([]);
      await thrown(service.find(input()));
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('잠금이 풀린 뒤의 실패는 0 에서 다시 센다', async () => {
      lastAttempt(5, at(-1));
      tx.account.findMany.mockResolvedValue([]);
      await expect(service.find(input())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(recorded()).toEqual(
        expect.objectContaining({ failedCount: 1, lockExpiresAt: null }),
      );
    });
  });

  it('잠금이 풀린 뒤 맞는 값이면 찾고 횟수를 0으로 되돌린다', async () => {
    lastAttempt(5, at(-1));
    await expect(service.find(input())).resolves.toEqual([
      'st*****m@gmail.com',
    ]);
    expect(recorded()).toEqual(
      expect.objectContaining({
        isSucceeded: true,
        failedCount: 0,
        lockExpiresAt: null,
      }),
    );
  });

  describe('막혀 있을 때', () => {
    beforeEach(() => lastAttempt(5, at(3 * MINUTE)));

    it('값이 맞아도 429 와 해제 시각을 알리고 계정을 찾지 않는다', async () => {
      const error = await thrown(service.find(input()));
      expect(error.getStatus()).toBe(429);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ lockExpiresAt: at(3 * MINUTE) }),
      );
      expect(tx.account.findMany).not.toHaveBeenCalled();
    });

    it('시도는 남기되 횟수와 해제 시각을 늘리지 않는다 — 늘리면 남의 잠금을 끝없이 미룰 수 있다', async () => {
      await thrown(service.find(input()));
      expect(recorded()).toEqual({
        phoneKey: phoneKeyOf(SECRET, PHONE),
        isSucceeded: false,
        failedCount: 5,
        lockExpiresAt: at(3 * MINUTE),
        attemptedAt: now,
      });
    });
  });

  it('번호 키로 잠금을 잡은 뒤 마지막 시도를 읽는다 — 병렬 요청으로 5회 제한을 넘기지 못하게', async () => {
    await service.find(input());
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.emailFindAttempt.findFirst.mock.invocationCallOrder[0],
    );
    const [strings, key] = tx.$executeRaw.mock.calls[0] as [string[], string];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe(phoneKeyOf(SECRET, PHONE));
    expect(tx.emailFindAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phoneKey: phoneKeyOf(SECRET, PHONE) },
        orderBy: { emailFindAttemptId: 'desc' },
      }),
    );
  });
});
