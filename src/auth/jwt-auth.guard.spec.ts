import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwt: { verifyAsync: jest.Mock };
  let sessions: { isActive: jest.Mock };
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
        type: 'account',
        email: 'account@whale.test',
        typ: 'access',
        sid: 11,
      }),
    };
    sessions = { isActive: jest.fn().mockResolvedValue(true) };
    reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as Reflector;
    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflector,
      sessions as unknown as AuthSessionService,
    );
  });

  it('액세스 토큰을 통과시키고 요청에 사용자를 싣는다', async () => {
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 7,
      type: 'account',
      email: 'account@whale.test',
      sid: 11,
    });
  });

  it('@Public 이면 토큰 없이 통과시킨다', async () => {
    metadata.isPublic = true;
    request.headers = {};
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('스킴 대소문자는 가리지 않는다', async () => {
    // RFC 7235 의 auth-scheme 은 대소문자를 구분하지 않는다. 중간 프록시가
    // 헤더를 정규화하면 소문자로 오기도 한다.
    for (const authorization of ['bearer 토큰', 'BEARER 토큰']) {
      request.headers = { authorization };
      await expect(guard.canActivate(context())).resolves.toBe(true);
    }
  });

  it('@UserTypes() 를 빈 목록으로 붙이면 아무도 통과하지 못한다', async () => {
    // 제한을 거는 것처럼 보이는 데코레이터가 조용히 전체 허용이 되면 안 된다.
    metadata.userTypes = [];
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );
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
      type: 'account',
      email: 'account@whale.test',
      typ: 'refresh',
    });
    await expect(guard.canActivate(context())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('@UserTypes 에 없는 종류면 403', async () => {
    metadata.userTypes = ['admin'];
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );

    metadata.userTypes = ['account', 'admin'];
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  describe('접속 상태 확인', () => {
    it('account 토큰은 그 접속 상태가 살아 있는지 확인하고 통과시킨다', async () => {
      await expect(guard.canActivate(context())).resolves.toBe(true);

      expect(sessions.isActive).toHaveBeenCalledWith(11, 7);
    });

    it('로그아웃·재설정으로 종료됐거나 만료된 접속의 토큰은 남은 유효시간과 상관없이 401', async () => {
      sessions.isActive.mockResolvedValue(false);

      await expect(guard.canActivate(context())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(request.user).toBeUndefined();
    });

    it('접속 상태 id 가 없는 account 토큰은 확인할 수 없으므로 401', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 7,
        type: 'account',
        email: 'account@whale.test',
        typ: 'access',
      });

      await expect(guard.canActivate(context())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('접속 상태가 없는 종류(admin)의 토큰은 확인하지 않는다', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 3,
        type: 'admin',
        email: 'admin@whale.test',
        typ: 'access',
      });

      await expect(guard.canActivate(context())).resolves.toBe(true);
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('admin 토큰에 sid 가 실려 와도 요청 사용자에는 싣지 않는다 — sid 는 account 의 접속 상태만 가리킨다', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: 3,
        type: 'admin',
        email: 'admin@whale.test',
        typ: 'access',
        sid: 99,
      });

      await guard.canActivate(context());

      expect(request.user).toEqual({
        id: 3,
        type: 'admin',
        email: 'admin@whale.test',
      });
    });

    it('인증이 먼저다 — 종료된 접속은 허용 종류가 아니어도 403 이 아니라 401', async () => {
      sessions.isActive.mockResolvedValue(false);
      metadata.userTypes = ['admin'];

      await expect(guard.canActivate(context())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('@Public 경로는 접속 상태를 확인하지 않는다', async () => {
      metadata.isPublic = true;
      request.headers = {};

      await guard.canActivate(context());

      expect(sessions.isActive).not.toHaveBeenCalled();
    });
  });
});
