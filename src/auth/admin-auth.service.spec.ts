import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminSessionService } from '../admin-session/admin-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuthService } from './admin-auth.service';
import { hashPassword } from './password';

const PASSWORD = 'own-Password1!';
const TEMP = 'TempPass1234';
const MIN = 60_000;
const EDITED_AT = new Date('2026-10-01T00:00:00Z');

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let ownHash: string;
  let tempHash: string;
  let prisma: {
    adminAccount: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    temporaryPassword: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    adminLoginLog: { create: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let sessions: {
    issue: jest.Mock;
    find: jest.Mock;
    extend: jest.Mock;
    revoke: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };

  beforeAll(async () => {
    ownHash = await hashPassword(PASSWORD);
    tempHash = await hashPassword(TEMP);
  });

  const BP = {
    bpCodeId: 3,
    bpCode: 'BP000123',
    tradeName: '고래상사',
    isPlatform: false,
  };
  const account = (over: Record<string, unknown> = {}) => ({
    adminAccountId: 7,
    loginId: 'bpmaster1',
    name: '홍길동',
    roleTypeCode: 'BM',
    passwordHash: ownHash,
    accountStatusCode: 'ACTIVE',
    isDeleted: false,
    failedLoginCount: 0,
    lockExpiresAt: null,
    isPasswordChangeRequired: false,
    updatedAt: EDITED_AT,
    bpCode: BP,
    ...over,
  });
  const temp = (over: Record<string, unknown> = {}) => ({
    temporaryPasswordId: 5,
    passwordHash: tempHash,
    expiresAt: new Date(Date.now() + 30 * MIN),
    usedAt: null,
    invalidatedAt: null,
    isDeleted: false,
    ...over,
  });
  const login = (password = PASSWORD, loginId = 'bpmaster1') =>
    service.login(
      { loginId, password, deviceInformation: 'chrome-1' },
      '10.0.0.1',
    );
  const logged = () =>
    prisma.adminLoginLog.create.mock.calls.map(
      (c: [{ data: Record<string, unknown> }]) => c[0].data,
    );

  beforeEach(async () => {
    const row = account();
    prisma = {
      adminAccount: {
        findUnique: jest.fn().mockResolvedValue(row),
        findUniqueOrThrow: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
      },
      temporaryPassword: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminLoginLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    sessions = {
      issue: jest.fn(
        async (_input: unknown, sign: (sid: number) => Promise<string>) => ({
          sessionId: 21,
          accessToken: await sign(21),
          refreshToken: '21.refresh',
          expiresAt: new Date('2026-10-13T04:00:00Z'),
        }),
      ),
      find: jest.fn().mockResolvedValue({ sessionId: 21, adminAccountId: 7 }),
      extend: jest.fn().mockResolvedValue(new Date('2026-10-13T05:00:00Z')),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValue('signed-access'),
      verifyAsync: jest.fn().mockResolvedValue({ sub: 7, typ: 'signup' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminSessionService, useValue: sessions },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AdminAuthService);
  });

  describe('login', () => {
    it('맞으면 직원 앱과 같은 모양으로 토큰과 계정을 준다', async () => {
      await expect(login()).resolves.toEqual({
        accessToken: 'signed-access',
        refreshToken: '21.refresh',
        refreshTokenExpiresAt: new Date('2026-10-13T04:00:00Z'),
        account: {
          adminAccountId: 7,
          loginId: 'bpmaster1',
          name: '홍길동',
          roleTypeCode: 'BM',
          bp: BP,
          isPasswordChangeRequired: false,
        },
      });
    });

    it('접근 토큰은 admin · 로그인ID · 세션 id 를 싣고 1시간이다', async () => {
      await login();
      const [claims, options] = jwt.signAsync.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(claims).toMatchObject({
        sub: 7,
        type: 'admin',
        loginId: 'bpmaster1',
        typ: 'access',
        sid: 21,
      });
      expect(typeof claims.jti).toBe('string');
      expect(options).toEqual({ expiresIn: '1h' });
    });

    it('성공은 기기 · 최근 로그인 · 접속 IP 이력을 남긴다', async () => {
      await login();
      expect(sessions.issue).toHaveBeenCalledWith(
        {
          adminAccountId: 7,
          deviceInformation: 'chrome-1',
          expiresAtCap: null,
        },
        expect.any(Function),
        prisma,
      );
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 7 },
        data: expect.objectContaining({
          lastLoginAt: expect.any(Date) as unknown,
          // 로그인은 계정 수정이 아니다 — 수정 일시 · 동시 수정 잠금(updatedAt)을 건드리지 않는다.
          updatedAt: EDITED_AT,
        }) as unknown,
      });
      expect(logged()).toEqual([
        { adminAccountId: 7, clientAddress: '10.0.0.1', isSucceeded: true },
      ]);
    });

    it('성공하면 쌓인 실패를 지운다', async () => {
      prisma.adminAccount.findUniqueOrThrow.mockResolvedValue(
        account({ failedLoginCount: 3 }),
      );
      await login();
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 7 },
        data: expect.objectContaining({
          failedLoginCount: 0,
          lockExpiresAt: null,
        }) as unknown,
      });
    });

    it('없는 아이디는 같은 문구 401, 계정 없이 남긴다', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(null);
      await expect(login()).rejects.toThrow(
        new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.'),
      );
      expect(logged()).toEqual([
        {
          adminAccountId: null,
          clientAddress: '10.0.0.1',
          isSucceeded: false,
          failureReason: 'PASSWORD_MISMATCH',
        },
      ]);
    });

    it('비밀번호가 틀리면 행을 잠그고 한 번 센다', async () => {
      await expect(login('wrong')).rejects.toThrow(UnauthorizedException);
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 7 },
        data: {
          failedLoginCount: 1,
          lockExpiresAt: null,
          updatedAt: EDITED_AT,
        },
      });
      expect(logged()[0]).toMatchObject({
        adminAccountId: 7,
        failureReason: 'PASSWORD_MISMATCH',
      });
    });

    it('다섯 번째로 틀리면 바로 잠금 429', async () => {
      prisma.adminAccount.findUniqueOrThrow.mockResolvedValue(
        account({ failedLoginCount: 4 }),
      );
      const error = (await login('wrong').catch(
        (e: unknown) => e,
      )) as HttpException;
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(error.getResponse()).toMatchObject({
        message:
          '로그인이 잠겼습니다. 5분 뒤에 다시 시도하거나 임시 비밀번호를 발급받아 주세요.',
      });
    });

    it('잠겨 있으면 맞는 비밀번호도 429, 세지 않는다', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ lockExpiresAt: new Date(Date.now() + MIN) }),
      );
      const error = (await login().catch((e: unknown) => e)) as HttpException;
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(prisma.adminAccount.update).not.toHaveBeenCalled();
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(logged()[0]).toMatchObject({ failureReason: 'LOCKED' });
    });

    it.each([
      ['탈퇴', { accountStatusCode: 'WITHDRAWN' }, 'WITHDRAWN'],
      ['삭제', { isDeleted: true }, 'PASSWORD_MISMATCH'],
    ])(
      '%s 계정은 맞는 비밀번호여도 없는 아이디와 같은 401',
      async (_, over, reason) => {
        prisma.adminAccount.findUnique.mockResolvedValue(account(over));
        await expect(login()).rejects.toThrow(
          new UnauthorizedException(
            '아이디 또는 비밀번호가 올바르지 않습니다.',
          ),
        );
        expect(sessions.issue).not.toHaveBeenCalled();
        expect(logged()[0]).toMatchObject({
          adminAccountId: 7,
          failureReason: reason,
        });
      },
    );

    it('미사용 계정은 비밀번호가 맞을 때만 이용 제한 403', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ accountStatusCode: 'INACTIVE' }),
      );
      await expect(login()).rejects.toThrow(
        new ForbiddenException(
          '사용이 제한된 계정입니다. 관리자에게 문의해 주세요.',
        ),
      );
      expect(logged()[0]).toMatchObject({ failureReason: 'INACTIVE' });
      await expect(login('wrong')).rejects.toThrow(UnauthorizedException);
    });

    it('검증하는 사이 비밀번호가 바뀌었으면 401, 세지 않는다', async () => {
      prisma.adminAccount.findUniqueOrThrow.mockResolvedValue(
        account({ passwordHash: 'scrypt$changed' }),
      );
      await expect(login()).rejects.toThrow(UnauthorizedException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    describe('임시 비밀번호', () => {
      it('살아 있는 임시 비밀번호로 들어오면 사용 시각을 남기고 세션은 그 만료에서 끝난다', async () => {
        const live = temp();
        prisma.temporaryPassword.findFirst.mockResolvedValue(live);
        prisma.temporaryPassword.findUnique.mockResolvedValue(live);

        const result = await login(TEMP);

        // 임시 비밀번호로 들어온 때에 강제 변경 대상이 된다(발급만으로는 아니다).
        expect(prisma.adminAccount.update).toHaveBeenCalledWith({
          where: { adminAccountId: 7 },
          data: expect.objectContaining({
            isPasswordChangeRequired: true,
          }) as unknown,
        });
        expect(result.account.isPasswordChangeRequired).toBe(true);
        expect(prisma.temporaryPassword.update).toHaveBeenCalledWith({
          where: { temporaryPasswordId: 5 },
          data: { usedAt: expect.any(Date) as unknown },
        });
        expect(sessions.issue).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAtCap: live.expiresAt }),
          expect.any(Function),
          prisma,
        );
      });

      it('살아 있는 임시 비밀번호만 찾는다', async () => {
        await login();
        expect(prisma.temporaryPassword.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              adminAccountId: 7,
              invalidatedAt: null,
              isDeleted: false,
              expiresAt: { gt: expect.any(Date) as unknown },
            },
            orderBy: { issuedAt: 'desc' },
          }),
        );
      });

      it('검증하는 사이 무효가 됐으면 401', async () => {
        prisma.temporaryPassword.findFirst.mockResolvedValue(temp());
        prisma.temporaryPassword.findUnique.mockResolvedValue(
          temp({ invalidatedAt: new Date() }),
        );
        await expect(login(TEMP)).rejects.toThrow(UnauthorizedException);
        expect(sessions.issue).not.toHaveBeenCalled();
      });

      it('기존 비밀번호로 들어오면 쓰지 않은 찾기용 임시 비밀번호를 무효로 하고 강제 변경을 푼다 — 무효로 할 것이 없어도', async () => {
        prisma.adminAccount.findUniqueOrThrow.mockResolvedValue(
          account({ isPasswordChangeRequired: true }),
        );
        prisma.temporaryPassword.updateMany.mockResolvedValue({ count: 0 });

        const result = await login();

        expect(prisma.temporaryPassword.updateMany).toHaveBeenCalledWith({
          where: {
            adminAccountId: 7,
            purpose: 'TEMPORARY',
            usedAt: null,
            invalidatedAt: null,
          },
          data: { invalidatedAt: expect.any(Date) as unknown },
        });
        expect(prisma.adminAccount.update).toHaveBeenCalledWith({
          where: { adminAccountId: 7 },
          data: expect.objectContaining({
            isPasswordChangeRequired: false,
          }) as unknown,
        });
        expect(result.account.isPasswordChangeRequired).toBe(false);
      });
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      prisma.adminAccount.findUnique.mockResolvedValue({
        loginId: 'bpmaster1',
        isPasswordChangeRequired: false,
      });
    });

    it('새 접근 토큰을 내고 세션을 민다 — 갱신 토큰은 그대로', async () => {
      await expect(service.refresh('21.refresh')).resolves.toEqual({
        accessToken: 'signed-access',
        refreshTokenExpiresAt: new Date('2026-10-13T05:00:00Z'),
      });
      expect(sessions.extend).toHaveBeenCalledWith(21, 'signed-access', null);
    });

    it('임시 비밀번호로 들어온 계정은 그 만료를 넘겨 밀지 않는다', async () => {
      const used = temp({ usedAt: new Date() });
      prisma.adminAccount.findUnique.mockResolvedValue({
        loginId: 'bpmaster1',
        isPasswordChangeRequired: true,
      });
      prisma.temporaryPassword.findFirst.mockResolvedValue(used);

      await service.refresh('21.refresh');

      expect(sessions.extend).toHaveBeenCalledWith(
        21,
        'signed-access',
        used.expiresAt,
      );
      expect(prisma.temporaryPassword.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            adminAccountId: 7,
            usedAt: { not: null },
            invalidatedAt: null,
            isDeleted: false,
            expiresAt: { gt: expect.any(Date) as unknown },
          },
        }),
      );
    });

    // 다시 발급돼 로그인에 쓴 임시 비밀번호가 끝났거나, 로그인 중에 관리자가 초기화해 표시만 켜진 경우.
    // 연장하면 바꿀 수도 없고 쓸 수도 없는 세션이 끝나지 않는다.
    it('강제 변경 대상인데 로그인에 쓴 살아 있는 임시 비밀번호가 없으면 세션을 끝내고 401', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue({
        loginId: 'bpmaster1',
        isPasswordChangeRequired: true,
      });
      prisma.temporaryPassword.findFirst.mockResolvedValue(null);

      await expect(service.refresh('21.refresh')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(sessions.revoke).toHaveBeenCalledWith(21);
      expect(sessions.extend).not.toHaveBeenCalled();
    });
  });

  it('logout 은 그 세션만 종료한다', async () => {
    await service.logout(21);
    expect(sessions.revoke).toHaveBeenCalledWith(21);
  });

  describe('loginFromSignupToken', () => {
    const redeem = (token = 'signup.jwt') =>
      service.loginFromSignupToken(token, 'chrome-1', '10.0.0.1');

    it('signupToken 이 맞으면 비밀번호 없이 로그인과 같은 모양을 준다', async () => {
      await expect(redeem()).resolves.toEqual({
        accessToken: 'signed-access',
        refreshToken: '21.refresh',
        refreshTokenExpiresAt: new Date('2026-10-13T04:00:00Z'),
        account: {
          adminAccountId: 7,
          loginId: 'bpmaster1',
          name: '홍길동',
          roleTypeCode: 'BM',
          bp: BP,
          isPasswordChangeRequired: false,
        },
      });
      expect(jwt.verifyAsync).toHaveBeenCalledWith('signup.jwt');
      expect(sessions.issue).toHaveBeenCalledWith(
        { adminAccountId: 7, deviceInformation: 'chrome-1' },
        expect.any(Function) as unknown,
      );
      expect(logged()).toEqual([
        expect.objectContaining({
          adminAccountId: 7,
          clientAddress: '10.0.0.1',
        }),
      ]);
    });

    it('만료·위조로 verifyAsync 가 던지면 401', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
      await expect(redeem()).rejects.toThrow(UnauthorizedException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('typ 이 signup 이 아니면 401 — 접근 · 갱신 토큰을 여기로 들이밀 수 없다', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 7, typ: 'access' });
      await expect(redeem()).rejects.toThrow(UnauthorizedException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('그 사이 계정이 삭제·탈퇴됐으면 401', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ isDeleted: true }),
      );
      await expect(redeem()).rejects.toThrow(UnauthorizedException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('계정이 미사용이면 403', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ accountStatusCode: 'INACTIVE' }),
      );
      await expect(redeem()).rejects.toThrow(ForbiddenException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });
});
