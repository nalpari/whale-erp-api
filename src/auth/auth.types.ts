/** 인증 주체의 종류. 테이블(staff / customers)과 1:1 로 대응한다. */
export type UserType = 'staff' | 'customer';

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
