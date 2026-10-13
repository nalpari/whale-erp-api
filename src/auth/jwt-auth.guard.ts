import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminSessionService } from '../admin-session/admin-session.service';
import { AuthSessionService } from '../auth-session/auth-session.service';
import {
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_PUBLIC,
  USER_TYPES,
} from './auth.decorators';
import { AuthUser, JwtPayload, UserType } from './auth.types';

// Passport 를 들이지 않는다. 전략이 하나뿐이라 얻는 것은 없고,
// @nestjs/passport + passport + passport-jwt 세 패키지가 늘어난다.
export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  '비밀번호를 변경한 뒤 이용할 수 있습니다';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly sessions: AuthSessionService,
    private readonly adminSessions: AdminSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();

    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    // RFC 7235 §2.1 의 auth-scheme 은 대소문자를 구분하지 않는다.
    if (scheme?.toLowerCase() !== 'bearer' || !token)
      throw new UnauthorizedException('인증 토큰이 필요합니다');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('토큰이 유효하지 않습니다');
    }
    // 리프레시 토큰은 갱신에만 쓴다. 수명이 길어 탈취 시 피해가 크다.
    if (payload.typ !== 'access')
      throw new UnauthorizedException('액세스 토큰이 아닙니다');

    // 두 종류 모두 토큰이 살아 있어도 그 접속이 종료됐거나 만료됐으면 거부한다. 서명만 보면
    // 로그아웃하거나 비밀번호를 재설정한 뒤에도 남은 유효시간(account 15분, admin 1시간) 동안
    // 통과한다. 인증을 끝낸 뒤에 허용 종류를 따진다.
    const { sid } = payload;
    if (typeof sid !== 'number')
      throw new UnauthorizedException('만료되었거나 종료된 접속입니다');
    let user: AuthUser;
    if (payload.type === 'account') {
      if (
        typeof payload.email !== 'string' ||
        !(await this.sessions.isActive(sid, payload.sub))
      )
        throw new UnauthorizedException('만료되었거나 종료된 접속입니다');
      user = { type: 'account', id: payload.sub, email: payload.email, sid };
    } else {
      const { loginId } = payload;
      const session =
        typeof loginId === 'string'
          ? await this.adminSessions.findActive(sid, payload.sub)
          : null;
      if (!session || typeof loginId !== 'string')
        throw new UnauthorizedException('만료되었거나 종료된 접속입니다');
      // 초기 · 임시 비밀번호로 들어와 아직 바꾸지 않았으면 팝업 경로만 연다(1팀 S-VFGQLI).
      if (
        session.isPasswordChangeRequired &&
        !this.reflector.getAllAndOverride<boolean>(
          ALLOW_PASSWORD_CHANGE_PENDING,
          targets,
        )
      )
        throw new ForbiddenException(PASSWORD_CHANGE_REQUIRED_MESSAGE);
      user = { type: 'admin', id: payload.sub, loginId, sid };
    }

    const allowed = this.reflector.getAllAndOverride<UserType[]>(
      USER_TYPES,
      targets,
    );
    // 길이를 보지 않는다. 빈 목록(@UserTypes() 처럼 인자를 빠뜨린 경우)을
    // "전체 허용"으로 읽으면, 제한을 거는 모양의 데코레이터가 조용히
    // 아무것도 하지 않는 상태가 된다. 허용 목록이 있으면 그 목록이 전부다.
    if (allowed && !allowed.includes(payload.type))
      throw new ForbiddenException('접근 권한이 없습니다');

    request.user = user;
    return true;
  }
}
