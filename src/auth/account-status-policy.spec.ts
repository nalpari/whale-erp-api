import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '@prisma/client';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountAuthService } from './account-auth.service';
import { verifyPassword } from './password';

// 비밀번호 검증만 바꿔 끼운다. 이 파일이 확인하는 것은 "무엇을 보고 로그인을 막는가"다.
jest.mock('./password', () => ({
  ...jest.requireActual<typeof import('./password')>('./password'),
  verifyPassword: jest.fn().mockResolvedValue(true),
}));

// 계정 상태 정책(WHALEERP-168)을 코드에 고정한다. 정책을 바꾸는 변경이 조용히 들어오지
// 못하게 하는 것이 목적이라, 이 테스트가 깨지면 정책 문서를 먼저 확인한다.
describe('계정 상태 정책', () => {
  describe('ACC-18 — 휴면 계정을 두지 않는다', () => {
    it('계정 상태에 휴면 값이 없다 — 가입 완료·연결 보류·탈퇴뿐이다', () => {
      // 탈퇴(WITHDRAWN)는 2026-10-07 에 더했고(WHALEERP-168), 휴면은 두지 않기로 했다. 값이 더 늘면
      // 이 테스트가 깨진다. 더하려면 로그인에서 그 상태를 어떻게 다룰지(막을지, 안내만 할지)를
      // 함께 정해야 한다.
      expect(Object.values(AccountStatus).sort()).toEqual([
        'JOINED',
        'LINK_HOLD',
        'WITHDRAWN',
      ]);
    });
  });

  describe('ACC-15 — 직원 계정은 퇴직해도 막지 않는다', () => {
    let service: AccountAuthService;
    const accessed: string[] = [];

    beforeEach(async () => {
      accessed.length = 0;
      // account 와 트랜잭션(실패 횟수) 밖의 어떤 표를 읽어도 기록한다. 직원 레코드(재직 상태)를
      // 읽는 순간 로그인 판정에 퇴직 여부가 끼어든 것이다.
      const prisma = new Proxy(
        {
          account: {
            findUnique: jest.fn().mockResolvedValue({
              accountId: 7,
              email: 'staff@example.com',
              passwordHash: 'scrypt$stored',
              realName: '홍길동',
              status: 'JOINED',
              failedLoginCount: 0,
              lockExpiresAt: null,
              createdAt: new Date('2021-01-01T00:00:00Z'),
              updatedAt: new Date('2021-01-01T00:00:00Z'),
            }),
            update: jest.fn(),
          },
        },
        {
          get(target, name: string | symbol): unknown {
            // `then` 은 await 할 때 thenable 인지 확인하는 접근이라 표를 읽은 것이 아니다.
            if (
              typeof name === 'string' &&
              name !== 'then' &&
              !(name in target)
            )
              accessed.push(name);
            return Reflect.get(target, name) as unknown;
          },
        },
      );
      const module = await Test.createTestingModule({
        providers: [
          AccountAuthService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: AuthSessionService,
            useValue: {
              issue: jest.fn().mockResolvedValue({
                authSessionId: 11,
                refreshToken: 'r',
                expiresAt: new Date(),
              }),
              recordLoginAttempt: jest.fn(),
            },
          },
          {
            provide: JwtService,
            useValue: { signAsync: jest.fn().mockResolvedValue('jwt') },
          },
        ],
      }).compile();
      service = module.get(AccountAuthService);
      (verifyPassword as jest.Mock).mockResolvedValue(true);
    });

    it('로그인 판정은 직원 레코드(재직·퇴직)를 읽지 않는다', async () => {
      await service.login({
        email: 'staff@example.com',
        password: 'correct-password',
      });

      expect(accessed).toEqual([]);
    });
  });

  describe('ACC-18 — 오래 쓰지 않았다고 막지 않는다', () => {
    it('로그인 판정은 마지막 사용 시점을 보지 않는다 — 4년 전에 만든 계정도 통과한다', async () => {
      const prisma = {
        account: {
          findUnique: jest.fn().mockResolvedValue({
            accountId: 7,
            email: 'staff@example.com',
            passwordHash: 'scrypt$stored',
            realName: '홍길동',
            status: 'JOINED',
            failedLoginCount: 0,
            lockExpiresAt: null,
            createdAt: new Date('2022-01-01T00:00:00Z'),
            updatedAt: new Date('2022-01-01T00:00:00Z'),
          }),
          update: jest.fn(),
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          AccountAuthService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: AuthSessionService,
            useValue: {
              issue: jest.fn().mockResolvedValue({
                authSessionId: 11,
                refreshToken: 'r',
                expiresAt: new Date(),
              }),
              recordLoginAttempt: jest.fn(),
            },
          },
          {
            provide: JwtService,
            useValue: { signAsync: jest.fn().mockResolvedValue('jwt') },
          },
        ],
      }).compile();
      (verifyPassword as jest.Mock).mockResolvedValue(true);

      await expect(
        module.get(AccountAuthService).login({
          email: 'staff@example.com',
          password: 'correct-password',
        }),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });
  });
});
