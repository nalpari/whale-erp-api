import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword, hashToken, verifyPassword } from './password';

// verifyPassword 를 실제 구현 그대로 감싸 호출 여부만 관찰한다. 계정이
// 없을 때도 검증을 돌리는지(타이밍 누설)를 시간 측정 없이 확인하기 위함이다.
jest.mock('./password', () => {
  const actual = jest.requireActual<typeof import('./password')>('./password');
  return { ...actual, verifyPassword: jest.fn(actual.verifyPassword) };
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    staff: { findUnique: jest.Mock; updateMany: jest.Mock };
    customer: { findUnique: jest.Mock; updateMany: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let row: {
    id: number;
    email: string;
    name: string;
    passwordHash: string;
    refreshTokenHash: string | null;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    row = {
      id: 7,
      email: 'staff@whale.test',
      name: '김직원',
      passwordHash: await hashPassword('pw12345!', { N: 1024, r: 8, p: 1 }),
      refreshTokenHash: null,
    };
    const table = () => ({
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    prisma = { staff: table(), customer: table() };
    jwt = {
      signAsync: jest.fn((payload: { typ: string }) =>
        Promise.resolve(`${payload.typ}-token`),
      ),
      verifyAsync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  const credentials = { email: 'staff@whale.test', password: 'pw12345!' };

  describe('login', () => {
    it('토큰 쌍과 사용자를 돌려주고 리프레시 해시를 저장한다', async () => {
      prisma.staff.findUnique.mockResolvedValue(row);

      const result = await service.login('staff', credentials);

      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 7,
          email: 'staff@whale.test',
          name: '김직원',
          type: 'staff',
        },
      });
      expect(prisma.staff.updateMany).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { refreshTokenHash: hashToken('refresh-token') },
      });
    });

    it('이메일을 소문자로 정규화해 조회한다', async () => {
      prisma.staff.findUnique.mockResolvedValue(row);
      await service.login('staff', {
        email: 'Staff@Whale.TEST',
        password: 'pw12345!',
      });
      expect(prisma.staff.findUnique).toHaveBeenCalledWith({
        where: { email: 'staff@whale.test' },
      });
    });

    it('customer 타입이면 customers 를 본다', async () => {
      prisma.customer.findUnique.mockResolvedValue(row);
      await service.login('customer', credentials);
      expect(prisma.customer.findUnique).toHaveBeenCalled();
      expect(prisma.staff.findUnique).not.toHaveBeenCalled();
    });

    it('없는 계정과 틀린 비밀번호를 같은 메세지로 거절한다', async () => {
      prisma.staff.findUnique.mockResolvedValue(null);
      const unknown = service.login('staff', {
        email: 'nobody@whale.test',
        password: 'pw12345!',
      });
      await expect(unknown).rejects.toThrow(UnauthorizedException);

      prisma.staff.findUnique.mockResolvedValue(row);
      const wrong = service.login('staff', {
        email: 'staff@whale.test',
        password: '틀린비번',
      });
      await expect(wrong).rejects.toThrow(UnauthorizedException);

      await expect(unknown.catch((e: Error) => e.message)).resolves.toBe(
        await wrong.catch((e: Error) => e.message),
      );
      expect(prisma.staff.updateMany).not.toHaveBeenCalled();
    });

    it('계정이 없어도 비밀번호 검증을 수행한다', async () => {
      // 메세지가 같아도 검증을 건너뛰면 응답 시간이 갈려 가입 여부가 샌다.
      prisma.staff.findUnique.mockResolvedValue(null);

      await expect(
        service.login('staff', { email: 'nobody@whale.test', password: 'x' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(verifyPassword).toHaveBeenCalledTimes(1);
      const [, storedArg] = (verifyPassword as jest.Mock).mock.calls[0] as [
        string,
        string,
      ];
      expect(storedArg).toMatch(/^scrypt\$/);
    });
  });

  describe('refresh', () => {
    const payload = {
      sub: 7,
      type: 'staff' as const,
      email: 'staff@whale.test',
      typ: 'refresh' as const,
    };
    const live = () => ({
      ...row,
      refreshTokenHash: hashToken('보관중인토큰'),
    });

    it('저장된 해시와 일치하면 새 토큰 쌍으로 회전한다', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue(live());

      const result = await service.refresh('보관중인토큰');

      expect(result.accessToken).toBe('access-token');
      // 조건부 갱신이어야 한다. 읽은 값을 그대로 믿고 덮어쓰면 동시 요청이
      // 둘 다 성공해 한쪽 클라이언트의 새 토큰이 즉시 죽는다.
      expect(prisma.staff.updateMany).toHaveBeenCalledWith({
        where: { id: 7, refreshTokenHash: hashToken('보관중인토큰') },
        data: { refreshTokenHash: hashToken('refresh-token') },
      });
    });

    it('동시 갱신에서 지면 거절하고, 이긴 쪽 세션도 함께 끊는다', async () => {
      // 같은 토큰으로 둘이 동시에 들어오면 한쪽만 조건부 갱신에 성공한다.
      // 진 쪽을 막는 것만으로는 부족하다. 먼저 소비한 쪽이 탈취자일 수 있고,
      // 그대로 두면 정상 사용자만 튕기고 공격자는 세션을 유지한다.
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue(live());
      prisma.staff.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.refresh('보관중인토큰')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.staff.updateMany).toHaveBeenLastCalledWith({
        where: { id: 7 },
        data: { refreshTokenHash: null },
      });
    });

    it('액세스 토큰으로는 갱신할 수 없다', async () => {
      jwt.verifyAsync.mockResolvedValue({ ...payload, typ: 'access' });
      await expect(service.refresh('access-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.staff.findUnique).not.toHaveBeenCalled();
    });

    it('이미 회전된 토큰이 다시 오면 살아 있는 세션까지 폐기한다', async () => {
      // 회전된 토큰의 재사용은 탈취 신호다. 그 요청만 막으면 먼저 쓴 쪽이
      // 세션을 그대로 가져간다.
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue({
        ...row,
        refreshTokenHash: hashToken('다른토큰'),
      });

      await expect(service.refresh('보관중인토큰')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.staff.updateMany).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { refreshTokenHash: null },
      });
    });

    it('로그아웃 상태의 토큰은 거절한다', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue({
        ...row,
        refreshTokenHash: null,
      });
      await expect(service.refresh('보관중인토큰')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('서명이 깨진 토큰은 거절한다', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      await expect(service.refresh('쓰레기')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('토큰이 가리키는 계정이 사라졌으면 거절한다', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue(null);
      await expect(service.refresh('보관중인토큰')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  it('같은 초에 두 번 발급해도 서로 다른 토큰이 나온다', async () => {
    // jti 가 없으면 payload 가 같고 iat 까지 같아 토큰이 바이트 단위로
    // 동일해진다. 그러면 회전해도 옛 토큰이 그대로 살아 있어 재사용을
    // 막을 수 없다.
    prisma.staff.findUnique.mockResolvedValue(row);
    jwt.signAsync.mockImplementation((payload: unknown) =>
      Promise.resolve(JSON.stringify(payload)),
    );

    const first = await service.login('staff', credentials);
    const second = await service.login('staff', credentials);

    expect(first.refreshToken).not.toBe(second.refreshToken);
  });

  it('로그아웃하면 저장된 리프레시 해시를 지운다', async () => {
    // 행이 이미 지워졌어도 500 이 되면 안 되므로 updateMany 를 쓴다.
    await service.logout({ id: 7, type: 'staff', email: 'staff@whale.test' });
    expect(prisma.staff.updateMany).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { refreshTokenHash: null },
    });
  });
});
