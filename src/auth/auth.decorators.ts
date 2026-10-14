import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { AuthUser, UserType } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const USER_TYPES = 'userTypes';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'allowPasswordChangePending';

/** 전역 가드에서 이 핸들러(또는 컨트롤러 전체)를 제외한다. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 지정한 종류의 토큰만 통과시킨다. 없으면 인증만 되면 통과한다. */
export const UserTypes = (...types: UserType[]) =>
  SetMetadata(USER_TYPES, types);

/**
 * 강제 비밀번호 변경을 마치지 않은 관리자도 부를 수 있는 경로. 가드는 그 밖의 관리자 경로를 403 으로 막는다
 * (1팀 S-VFGQLI — 변경 전에는 팝업과 로그아웃만). 로그아웃 · 로그인 정보 · 강제 변경에만 붙인다.
 */
export const AllowPasswordChangePending = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

/** 가드가 검증해 실어 둔 사용자. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
