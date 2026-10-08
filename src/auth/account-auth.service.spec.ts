import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountAuthService } from './account-auth.service';
import { verifyPassword } from './password';

// 비밀번호 검증만 바꿔 끼운다. 해시 생성(더미 해시)은 진짜를 쓴다.
jest.mock('./password', () => ({
  ...jest.requireActual<typeof import('./password')>('./password'),
  verifyPassword: jest.fn(),
}));

const verifyPasswordMock = verifyPassword as jest.Mock;

describe('AccountAuthService', () => {
  let service: AccountAuthService;
  let prisma: {
    account: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  // 실패 횟수를 세거나 성공을 처리하는 트랜잭션 안에서 쓰는 클라이언트. 행
  // 잠금(FOR UPDATE)과 그 행의 현재 상태 읽기, 새 상태 쓰기가 한 트랜잭션 안에서
  // 일어난다.
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
  };
  let sessions: {
    issue: jest.Mock;
    recordLoginAttempt: jest.Mock;
    validate: jest.Mock;
    revoke: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock };

  const now = new Date('2026-10-07T03:00:00.000Z');
  const FIVE_MINUTES = 5 * 60 * 1000;
  const expiresAt = new Date('2026-11-06T03:00:00.000Z');
  const account = (overrides: Record<string, unknown> = {}) => ({
    accountId: 7,
    email: 'staff@example.com',
    passwordHash: 'scrypt$stored-hash',
    realName: '홍길동',
    status: 'JOINED',
    failedLoginCount: 0,
    lockExpiresAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          failedLoginCount: 0,
          lockExpiresAt: null,
          passwordHash: 'scrypt$stored-hash',
          status: 'JOINED',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      account: {
        findUnique: jest.fn().mockResolvedValue(account()),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    sessions = {
      issue: jest.fn().mockResolvedValue({
        authSessionId: 11,
        refreshToken: 'refresh-raw',
        expiresAt,
      }),
      recordLoginAttempt: jest.fn().mockResolvedValue(undefined),
      validate: jest.fn().mockResolvedValue({
        authSessionId: 11,
        accountId: 7,
        deviceIdentifier: null,
        expiresAt,
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('access-jwt') };
    verifyPasswordMock.mockReset().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthSessionService, useValue: sessions },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AccountAuthService);
  });

  afterEach(() => jest.useRealTimers());

  const login = (overrides: Record<string, unknown> = {}) =>
    service.login({
      email: 'staff@example.com',
      password: 'correct-password',
      ...overrides,
    });

  describe('성공', () => {
    it('이메일과 비밀번호가 맞으면 접속 상태를 발급하고 토큰을 돌려준다', async () => {
      const result = await login();

      expect(result).toEqual({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-raw',
        refreshTokenExpiresAt: expiresAt,
        account: {
          accountId: 7,
          email: 'staff@example.com',
          realName: '홍길동',
          status: 'JOINED',
        },
      });
    });

    it('이메일의 공백과 대소문자를 정리해 조회한다', async () => {
      await login({ email: '  Staff@Example.COM ' });

      expect(prisma.account.findUnique).toHaveBeenCalledWith({
        where: { email: 'staff@example.com' },
      });
    });

    it('조회 키는 이메일뿐이다 — 본인인증한 휴대전화번호는 로그인 아이디가 아니다', async () => {
      await login();

      const [args] = prisma.account.findUnique.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(Object.keys(args.where)).toEqual(['email']);
    });

    it('받은 기기 식별 정보로 접속 상태를 발급한다', async () => {
      await login({ deviceIdentifier: 'iphone-1' });

      expect(sessions.issue).toHaveBeenCalledWith(
        { accountId: 7, deviceIdentifier: 'iphone-1' },
        tx,
      );
    });

    it('액세스 토큰에 계정·종류·접속 상태 id 를 싣고 15분 뒤 만료시킨다', async () => {
      await login();

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 7,
          type: 'account',
          email: 'staff@example.com',
          typ: 'access',
          sid: 11,
        }),
        { expiresIn: '15m' },
      );
    });

    it('토큰마다 다른 jti 를 싣는다', async () => {
      await login();
      await login();

      const jtis = jwt.signAsync.mock.calls.map(
        (call) => (call as [{ jti: string }])[0].jti,
      );
      expect(jtis[0]).toBeTruthy();
      expect(jtis[0]).not.toBe(jtis[1]);
    });

    it('성공한 시도를 이력으로 남긴다', async () => {
      await login();

      expect(sessions.recordLoginAttempt).toHaveBeenCalledWith(
        { accountId: 7, email: 'staff@example.com', isSucceeded: true },
        tx,
      );
    });

    it('가입 연결이 보류된 계정도 로그인되고, 보류 상태가 응답에 담긴다', async () => {
      prisma.account.findUnique.mockResolvedValue(
        account({ status: 'LINK_HOLD' }),
      );

      const result = await login();

      expect(result.accessToken).toBe('access-jwt');
      expect(result.account.status).toBe('LINK_HOLD');
    });

    it('응답에 비밀번호 해시를 싣지 않는다', async () => {
      const result = await login();

      expect(JSON.stringify(result)).not.toContain('scrypt$stored-hash');
    });
  });

  describe('실패', () => {
    const MESSAGE = '이메일 또는 비밀번호가 올바르지 않습니다';

    it('비밀번호가 틀리면 401 이다', async () => {
      verifyPasswordMock.mockResolvedValue(false);

      await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('없는 이메일도 401 이다', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('아이디가 틀렸는지 비밀번호가 틀렸는지 구분해 알리지 않는다', async () => {
      verifyPasswordMock.mockResolvedValue(false);
      const wrongPassword = await login().catch(
        (e: UnauthorizedException) => e.message,
      );
      prisma.account.findUnique.mockResolvedValue(null);
      const unknownEmail = await login().catch(
        (e: UnauthorizedException) => e.message,
      );

      expect(wrongPassword).toBe(MESSAGE);
      expect(unknownEmail).toBe(MESSAGE);
    });

    it('없는 이메일에도 비밀번호 검증을 돌린다 — 걸린 시간으로 가입 여부를 알 수 없게', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      await login().catch(() => undefined);

      expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
      const [plain, dummy] = verifyPasswordMock.mock.calls[0] as [
        string,
        string,
      ];
      expect(plain).toBe('correct-password');
      expect(dummy.startsWith('scrypt$')).toBe(true);
    });

    it('없는 이메일이 비밀번호 검증에서 통과하더라도 로그인시키지 않는다', async () => {
      prisma.account.findUnique.mockResolvedValue(null);
      verifyPasswordMock.mockResolvedValue(true);

      await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('틀리면 접속 상태를 만들지 않는다', async () => {
      verifyPasswordMock.mockResolvedValue(false);

      await login().catch(() => undefined);

      expect(sessions.issue).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('비밀번호가 틀린 시도는 계정을 붙여 불일치로 남긴다', async () => {
      verifyPasswordMock.mockResolvedValue(false);

      await login().catch(() => undefined);

      expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
        accountId: 7,
        email: 'staff@example.com',
        isSucceeded: false,
        failureReason: 'PASSWORD_MISMATCH',
      });
    });

    it('없는 이메일의 시도는 계정 없이 없는 계정으로 남긴다', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      await login().catch(() => undefined);

      expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
        email: 'staff@example.com',
        isSucceeded: false,
        failureReason: 'ACCOUNT_NOT_FOUND',
      });
    });
  });

  describe('잠금', () => {
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
    // 이 시점에 DB 에 저장돼 있는 실패 횟수와 잠금 시각. 트랜잭션 안에서 읽힌다.
    const storedState = (
      failedLoginCount: number,
      lockExpiresAt: Date | null,
    ) =>
      tx.account.findUniqueOrThrow.mockResolvedValue({
        failedLoginCount,
        lockExpiresAt,
      });
    const lockedAccount = (lockExpiresAt: Date) =>
      account({ failedLoginCount: 5, lockExpiresAt });

    describe('잠겨 있는 동안', () => {
      beforeEach(() => {
        prisma.account.findUnique.mockResolvedValue(lockedAccount(at(60_000)));
      });

      it('맞는 비밀번호여도 429 로 거부하고, 풀리는 길을 안내한다', async () => {
        const error: unknown = await login().catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 429 });
        expect((error as Error).message).toContain('비밀번호를 재설정');
      });

      it('비밀번호 검증도 접속 상태 발급도 하지 않는다', async () => {
        await login().catch(() => undefined);

        expect(verifyPasswordMock).not.toHaveBeenCalled();
        expect(sessions.issue).not.toHaveBeenCalled();
      });

      it('잠금으로 거부된 시도를 계정을 붙여 이력에 남긴다', async () => {
        await login().catch(() => undefined);

        expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
          accountId: 7,
          email: 'staff@example.com',
          isSucceeded: false,
          failureReason: 'LOCKED',
        });
      });

      it('잠긴 동안의 시도는 실패 횟수에 더하지 않는다', async () => {
        await login().catch(() => undefined);

        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('잠금이 풀리면', () => {
      it('해제 시각이 지났으면 로그인된다', async () => {
        prisma.account.findUnique.mockResolvedValue(lockedAccount(at(-1)));

        const result = await login();

        expect(result.accessToken).toBe('access-jwt');
      });

      it('해제 시각과 정확히 같은 순간에도 로그인된다', async () => {
        prisma.account.findUnique.mockResolvedValue(lockedAccount(at(0)));

        await expect(login()).resolves.toMatchObject({
          accessToken: 'access-jwt',
        });
      });
    });

    describe('비밀번호가 틀렸을 때', () => {
      beforeEach(() => verifyPasswordMock.mockResolvedValue(false));

      it('실패를 한 번 세어 저장하고 401 로 답한다', async () => {
        await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 1, lockExpiresAt: null },
        });
      });

      it('세기 전에 그 행을 잠그고 읽는다 — 동시 요청이 5회 제한을 우회하지 못하게', async () => {
        await login().catch(() => undefined);

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
        expect(strings.join('?')).toContain('FOR UPDATE');
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          tx.account.findUniqueOrThrow.mock.invocationCallOrder[0],
        );
        expect(
          tx.account.findUniqueOrThrow.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.account.update.mock.invocationCallOrder[0]);
      });

      it('4번째 실패까지는 잠그지 않고 401 이다', async () => {
        storedState(3, null);

        await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 4, lockExpiresAt: null },
        });
      });

      it('5번째 실패에 지금부터 5분 동안 잠그고 429 로 답한다', async () => {
        storedState(4, null);

        const error: unknown = await login().catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 429 });
        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 5, lockExpiresAt: at(FIVE_MINUTES) },
        });
      });

      it('잠그게 된 시도도 틀린 비밀번호로 이력에 남긴다', async () => {
        storedState(4, null);

        await login().catch(() => undefined);

        expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
          accountId: 7,
          email: 'staff@example.com',
          isSucceeded: false,
          failureReason: 'PASSWORD_MISMATCH',
        });
      });

      it('시각은 행 잠금을 잡은 뒤에 본다 — 기다리는 사이 풀린 잠금을 잠긴 것으로 보지 않게', async () => {
        // 처음 읽을 때는 아직 잠겨 있었지만, 잠금을 기다리는 사이 해제 시각이 지났다.
        prisma.account.findUnique.mockResolvedValue(
          lockedAccount(at(FIVE_MINUTES)),
        );
        prisma.account.findUnique.mockResolvedValueOnce(account());
        storedState(5, at(1000));
        tx.$queryRaw.mockImplementation(() => {
          jest.setSystemTime(at(2000));
          return Promise.resolve([]);
        });

        await login().catch(() => undefined);

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 1, lockExpiresAt: null },
        });
      });

      it('잠금이 풀린 뒤의 첫 실패는 1 부터 다시 센다', async () => {
        prisma.account.findUnique.mockResolvedValue(lockedAccount(at(-1)));
        storedState(5, at(-1));

        await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 1, lockExpiresAt: null },
        });
      });

      it('읽는 사이에 다른 요청이 먼저 잠갔으면 횟수를 더하지 않고 429 로 답한다', async () => {
        // findUnique 는 잠기기 전을 봤고, 트랜잭션 안에서 읽으니 이미 잠겨 있다.
        storedState(5, at(60_000));

        const error: unknown = await login().catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 429 });
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('없는 이메일은 셀 계정이 없다', async () => {
        prisma.account.findUnique.mockResolvedValue(null);

        await login().catch(() => undefined);

        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('로그인에 성공하면', () => {
      // 트랜잭션 안에서 잠그고 다시 읽은 행.
      const storedRow = (overrides: Record<string, unknown> = {}) =>
        tx.account.findUniqueOrThrow.mockResolvedValue({
          failedLoginCount: 0,
          lockExpiresAt: null,
          passwordHash: 'scrypt$stored-hash',
          status: 'JOINED',
          ...overrides,
        });

      it('쌓인 실패 횟수를 0 으로 되돌린다', async () => {
        storedRow({ failedLoginCount: 3 });

        await login();

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 0, lockExpiresAt: null },
        });
      });

      it('풀린 잠금의 기록도 함께 지운다', async () => {
        prisma.account.findUnique.mockResolvedValue(lockedAccount(at(-1)));
        storedRow({ failedLoginCount: 5, lockExpiresAt: at(-1) });

        await login();

        expect(tx.account.update).toHaveBeenCalledWith({
          where: { accountId: 7 },
          data: { failedLoginCount: 0, lockExpiresAt: null },
        });
      });

      it('지울 것이 없으면 쓰지 않는다', async () => {
        await login();

        expect(tx.account.update).not.toHaveBeenCalled();
        expect(prisma.account.update).not.toHaveBeenCalled();
      });

      it('행을 잠그고 다시 읽은 뒤 초기화·발급·이력을 한 트랜잭션에서 한다', async () => {
        storedRow({ failedLoginCount: 2 });

        await login();

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
        expect(strings.join('?')).toContain('FOR UPDATE');
        const order = [
          tx.$queryRaw,
          tx.account.findUniqueOrThrow,
          tx.account.update,
          sessions.issue,
        ].map((m) => m.mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect((sessions.issue.mock.calls[0] as unknown[])[1]).toBe(tx);
        expect(
          (sessions.recordLoginAttempt.mock.calls[0] as unknown[])[1],
        ).toBe(tx);
      });

      it('검증하는 사이 다른 요청이 잠갔으면 429 이고 접속 상태를 만들지 않는다', async () => {
        storedRow({ failedLoginCount: 5, lockExpiresAt: at(60_000) });

        const error: unknown = await login().catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 429 });
        expect(sessions.issue).not.toHaveBeenCalled();
        expect(tx.account.update).not.toHaveBeenCalled();
        expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
          accountId: 7,
          email: 'staff@example.com',
          isSucceeded: false,
          failureReason: 'LOCKED',
        });
      });

      it('검증하는 사이 비밀번호가 재설정됐으면 401 이고 접속 상태를 만들지 않는다 — 옛 비밀번호로 새 접속이 생기면 재설정이 무의미하다', async () => {
        storedRow({ passwordHash: 'scrypt$new-hash' });

        await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(sessions.issue).not.toHaveBeenCalled();
        expect(jwt.signAsync).not.toHaveBeenCalled();
        expect(tx.account.update).not.toHaveBeenCalled();
      });

      it('검증하는 사이 탈퇴했으면 401 이고 접속 상태를 만들지 않는다', async () => {
        storedRow({ status: 'WITHDRAWN' });

        await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(sessions.issue).not.toHaveBeenCalled();
      });

      it('검증하는 사이 탈퇴했으면 없는 계정으로 남긴다 — 탈퇴는 없는 계정과 같다', async () => {
        storedRow({ status: 'WITHDRAWN' });

        await login().catch(() => undefined);

        expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
          email: 'staff@example.com',
          isSucceeded: false,
          failureReason: 'ACCOUNT_NOT_FOUND',
        });
      });

      it('검증하는 사이 비밀번호가 바뀌었으면 지금 비밀번호와 다르므로 불일치로 남긴다', async () => {
        storedRow({ passwordHash: 'scrypt$new-hash' });

        await login().catch(() => undefined);

        expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
          accountId: 7,
          email: 'staff@example.com',
          isSucceeded: false,
          failureReason: 'PASSWORD_MISMATCH',
        });
      });
    });
  });

  describe('refresh', () => {
    it('살아 있는 접속이면 새 액세스 토큰을 주고, 갱신 토큰은 그대로 둔다', async () => {
      const result = await service.refresh('refresh-raw');

      expect(sessions.validate).toHaveBeenCalledWith('refresh-raw');
      expect(result).toEqual({
        accessToken: 'access-jwt',
        refreshTokenExpiresAt: expiresAt,
      });
      // 회전하지 않는다. 정책은 마지막 사용 시각 + 30일 이다.
      expect(result).not.toHaveProperty('refreshToken');
    });

    it('새 액세스 토큰은 같은 접속 상태의 sid 를 싣는다', async () => {
      await service.refresh('refresh-raw');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 7,
          type: 'account',
          email: 'staff@example.com',
          typ: 'access',
          sid: 11,
        }),
        { expiresIn: '15m' },
      );
    });

    it('만료·종료·없는 토큰은 접속 상태 서비스의 401 을 그대로 던진다', async () => {
      sessions.validate.mockRejectedValue(new UnauthorizedException('x'));

      await expect(service.refresh('bad')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('이메일은 지금 계정 행에서 읽는다', async () => {
      prisma.account.findUnique.mockResolvedValue(
        account({ email: 'changed@example.com' }),
      );

      await service.refresh('refresh-raw');

      expect(prisma.account.findUnique).toHaveBeenCalledWith({
        where: { accountId: 7 },
        select: { email: true },
      });
      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'changed@example.com' }),
        expect.anything(),
      );
    });
  });

  describe('logout', () => {
    it('그 접속 상태를 종료한다', async () => {
      await service.logout(11);

      expect(sessions.revoke).toHaveBeenCalledWith(11);
    });
  });

  describe('탈퇴한 계정', () => {
    const MESSAGE = '이메일 또는 비밀번호가 올바르지 않습니다';
    beforeEach(() => {
      prisma.account.findUnique.mockResolvedValue(
        account({ status: 'WITHDRAWN' }),
      );
    });

    it('비밀번호가 맞아도 로그인되지 않는다', async () => {
      await expect(login()).rejects.toBeInstanceOf(UnauthorizedException);

      expect(sessions.issue).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('없는 이메일과 같은 메시지로 답한다 — 탈퇴한 계정이었다는 것을 알리지 않는다', async () => {
      const withdrawn = await login().catch(
        (e: UnauthorizedException) => e.message,
      );
      prisma.account.findUnique.mockResolvedValue(null);
      const unknown = await login().catch(
        (e: UnauthorizedException) => e.message,
      );

      expect(withdrawn).toBe(MESSAGE);
      expect(unknown).toBe(MESSAGE);
    });

    it('없는 계정처럼 비밀번호 검증을 돌려 걸린 시간으로 알 수 없게 한다', async () => {
      await login().catch(() => undefined);

      expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
      const [, hash] = verifyPasswordMock.mock.calls[0] as [string, string];
      expect(hash).not.toBe('scrypt$stored-hash');
      expect(hash.startsWith('scrypt$')).toBe(true);
    });

    it('이력에는 계정을 붙이지 않고 없는 계정으로 남긴다', async () => {
      await login().catch(() => undefined);

      expect(sessions.recordLoginAttempt).toHaveBeenCalledWith({
        email: 'staff@example.com',
        isSucceeded: false,
        failureReason: 'ACCOUNT_NOT_FOUND',
      });
    });

    it('실패 횟수를 세지 않고, 잠금 상태여도 잠금이 아니라 없는 계정으로 답한다', async () => {
      prisma.account.findUnique.mockResolvedValue(
        account({
          status: 'WITHDRAWN',
          failedLoginCount: 5,
          lockExpiresAt: new Date(now.getTime() + 60_000),
        }),
      );

      const error: unknown = await login().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(sessions.recordLoginAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ failureReason: 'ACCOUNT_NOT_FOUND' }),
      );
    });

    it('가입 연결이 보류된 계정은 탈퇴가 아니므로 여전히 로그인된다', async () => {
      prisma.account.findUnique.mockResolvedValue(
        account({ status: 'LINK_HOLD' }),
      );

      await expect(login()).resolves.toMatchObject({
        accessToken: 'access-jwt',
      });
    });
  });
});
