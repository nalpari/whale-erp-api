import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, USER_TYPES } from './auth.decorators';
import { JwtPayload, UserType } from './auth.types';

// Passport 를 들이지 않는다. 전략이 하나뿐이라 얻는 것은 없고,
// @nestjs/passport + passport + passport-jwt 세 패키지가 늘어난다.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();

    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token)
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

    const allowed = this.reflector.getAllAndOverride<UserType[]>(
      USER_TYPES,
      targets,
    );
    if (allowed?.length && !allowed.includes(payload.type))
      throw new ForbiddenException('접근 권한이 없습니다');

    request.user = {
      id: payload.sub,
      type: payload.type,
      email: payload.email,
    };
    return true;
  }
}
