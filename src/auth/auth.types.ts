/**
 * 인증 주체의 종류. 로그인 테이블과 1:1 로 대응한다 — `admin` 은 1팀 admin_accounts(관리자 웹),
 * `account` 는 3팀 accounts(직원 근무 앱). 지금 토큰을 내는 로그인은 `account` 하나이고, `admin` 은
 * 1팀 로그인이 생기면 쓴다.
 * 견본의 staff / customer 를 지우며 새 로그인 자리로 바꿨다 (2026-10-07).
 */
export type UserType = 'admin' | 'account';

/**
 * 가드가 검증을 마치고 요청에 실어 주는 값. 종류에 따라 갈린다 — account 는 접속 상태(`sid`)가
 * 반드시 있고, admin 은 없다. 1팀이 관리자 접속 상태를 두게 되면 `AdminUser` 에 그 칸을 더하고
 * 가드에서 채운다. 선택 칸 하나로 두면 "account 인데 sid 가 없는" 값이 타입상 만들어진다.
 */
export type AuthUser = AccountUser | AdminUser;

export interface AccountUser {
  type: 'account';
  id: number;
  email: string;
  /** 이 요청의 토큰을 낸 접속 상태. 로그아웃이 이 접속만 종료한다. */
  sid: number;
}

export interface AdminUser {
  type: 'admin';
  id: number;
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
  /** 이 토큰을 낸 접속 상태(auth_sessions)의 id. 접속 상태가 있는 주체(account)만 싣는다. */
  sid?: number;
}
