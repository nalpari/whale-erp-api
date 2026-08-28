import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { AuthUser, UserType } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const USER_TYPES = 'userTypes';

/** 전역 가드에서 이 핸들러(또는 컨트롤러 전체)를 제외한다. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 지정한 종류의 토큰만 통과시킨다. 없으면 인증만 되면 통과한다. */
export const UserTypes = (...types: UserType[]) =>
  SetMetadata(USER_TYPES, types);

/** 가드가 검증해 실어 둔 사용자. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
