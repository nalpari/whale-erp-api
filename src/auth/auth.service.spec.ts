import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword, hashToken } from './password';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    staff: { findUnique: jest.Mock; update: jest.Mock };
    customer: { findUnique: jest.Mock; update: jest.Mock };
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
    row = {
      id: 7,
      email: 'staff@whale.test',
      name: '김직원',
      passwordHash: await hashPassword('pw12345!'),
      refreshTokenHash: null,
    };
    prisma = {
      staff: { findUnique: jest.fn(), update: jest.fn() },
      customer: { findUnique: jest.fn(), update: jest.fn() },
    };
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

  describe('login', () => {
    it('토큰 쌍과 사용자를 돌려주고 리프레시 해시를 저장한다', async () => {
      prisma.staff.findUnique.mockResolvedValue(row);

      const result = await service.login('staff', {
        email: 'staff@whale.test',
        password: 'pw12345!',
      });

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
      expect(prisma.staff.update).toHaveBeenCalledWith({
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
      await service.login('customer', {
        email: 'staff@whale.test',
        password: 'pw12345!',
      });
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
      expect(prisma.staff.update).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const payload = {
      sub: 7,
      type: 'staff' as const,
      email: 'staff@whale.test',
      typ: 'refresh' as const,
    };

    it('저장된 해시와 일치하면 새 토큰 쌍으로 회전한다', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue({
        ...row,
        refreshTokenHash: hashToken('보관중인토큰'),
      });

      const result = await service.refresh('보관중인토큰');

      expect(result.accessToken).toBe('access-token');
      expect(prisma.staff.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { refreshTokenHash: hashToken('refresh-token') },
      });
    });

    it('액세스 토큰으로는 갱신할 수 없다', async () => {
      jwt.verifyAsync.mockResolvedValue({ ...payload, typ: 'access' });
      await expect(service.refresh('access-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.staff.findUnique).not.toHaveBeenCalled();
    });

    it('이미 회전됐거나 로그아웃된 토큰은 거절한다', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.staff.findUnique.mockResolvedValue({
        ...row,
        refreshTokenHash: hashToken('다른토큰'),
      });
      await expect(service.refresh('보관중인토큰')).rejects.toThrow(
        UnauthorizedException,
      );

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
  });

  it('같은 초에 두 번 발급해도 서로 다른 토큰이 나온다', async () => {
    // jti 가 없으면 payload 가 같고 iat 까지 같아 토큰이 바이트 단위로
    // 동일해진다. 그러면 회전해도 옛 토큰이 그대로 살아 있어 재사용을
    // 막을 수 없다.
    prisma.staff.findUnique.mockResolvedValue(row);
    jwt.signAsync.mockImplementation((payload: unknown) =>
      Promise.resolve(JSON.stringify(payload)),
    );
    const dto = { email: 'staff@whale.test', password: 'pw12345!' };

    const first = await service.login('staff', dto);
    const second = await service.login('staff', dto);

    expect(first.refreshToken).not.toBe(second.refreshToken);
  });

  it('로그아웃하면 저장된 리프레시 해시를 지운다', async () => {
    await service.logout({ id: 7, type: 'staff', email: 'staff@whale.test' });
    expect(prisma.staff.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { refreshTokenHash: null },
    });
  });
});
