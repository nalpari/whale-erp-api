/**
 * 인증 주체의 종류. 로그인 테이블과 1:1 로 대응한다 — `admin` 은 1팀 admin_accounts(관리자 웹),
 * `account` 는 3팀 accounts(직원 근무 앱). 아직 이 값으로 토큰을 내는 로그인은 없다.
 * 견본의 staff / customer 를 지우며 새 로그인 자리로 바꿨다 (2026-10-07).
 */
export type UserType = 'admin' | 'account';

/** 가드가 검증을 마치고 요청에 실어 주는 값. */
export interface AuthUser {
  id: number;
  type: UserType;
  email: string;
}

export interface JwtPayload {
  sub: number;
  type: UserType;
  email: string;
  /**
   * 액세스인지 리프레시인지. 이 필드가 없으면 리프레시 토큰을
   * Authorization 헤더에 실어 API 를 호출하는 것을 막을 수 없다.
   */
  typ: 'access' | 'refresh';
}
