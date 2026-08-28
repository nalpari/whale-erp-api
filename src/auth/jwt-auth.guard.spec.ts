import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwt: { verifyAsync: jest.Mock };
  let reflector: Reflector;
  let request: { headers: Record<string, string>; user?: unknown };
  let metadata: Record<string, unknown>;

  const context = () =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => 'handler',
      getClass: () => 'class',
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    request = { headers: { authorization: 'Bearer 토큰' } };
    metadata = {};
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 7,
        type: 'staff',
        email: 'staff@whale.test',
        typ: 'access',
      }),
    };
    reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as Reflector;
    guard = new JwtAuthGuard(jwt as unknown as JwtService, reflector);
  });

  it('액세스 토큰을 통과시키고 요청에 사용자를 싣는다', async () => {
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 7,
      type: 'staff',
      email: 'staff@whale.test',
    });
  });

  it('@Public 이면 토큰 없이 통과시킨다', async () => {
    metadata.isPublic = true;
    request.headers = {};
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('Authorization 헤더가 없거나 형식이 다르면 401', async () => {
    for (const authorization of [undefined, '', '토큰', 'Basic 토큰']) {
      request.headers = authorization === undefined ? {} : { authorization };
      await expect(guard.canActivate(context())).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('서명이 깨졌거나 만료된 토큰은 401', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    await expect(guard.canActivate(context())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('리프레시 토큰으로는 API 를 호출할 수 없다', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 7,
      type: 'staff',
      email: 'staff@whale.test',
      typ: 'refresh',
    });
    await expect(guard.canActivate(context())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('@UserTypes 에 없는 종류면 403', async () => {
    metadata.userTypes = ['customer'];
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );

    metadata.userTypes = ['staff', 'customer'];
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });
});
