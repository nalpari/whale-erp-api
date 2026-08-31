import { UserType } from '../auth.types';

export class AuthUserResponseDto {
  id: number;
  email: string;
  name: string;
  type: UserType;
}

export class TokenResponseDto {
  /** Authorization: Bearer <accessToken> 으로 API 를 호출한다. */
  accessToken: string;
  /** 액세스 토큰이 만료되면 POST /auth/refresh 에 실어 보낸다. */
  refreshToken: string;
  user: AuthUserResponseDto;
}
