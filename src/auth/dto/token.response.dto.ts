import { ApiProperty } from '@nestjs/swagger';
import { USER_TYPE_VALUES, type UserType } from '../auth.types';

export class AuthUserResponseDto {
  id: number;
  email: string;
  name: string;
  // enumName 이 있어야 문서에 이름 붙은 enum(components.schemas.UserType)으로 나온다.
  // 없으면 플러그인이 이름 없는 인라인 enum 을 만들고, front·staff 가 가져다 쓸 타입이 생기지 않는다.
  @ApiProperty({ enum: USER_TYPE_VALUES, enumName: 'UserType' })
  type: UserType;
}

export class TokenResponseDto {
  /** Authorization: Bearer <accessToken> 으로 API 를 호출한다. */
  accessToken: string;
  /** 액세스 토큰이 만료되면 POST /auth/refresh 에 실어 보낸다. */
  refreshToken: string;
  user: AuthUserResponseDto;
}
