import { IsJWT } from 'class-validator';

export class RefreshDto {
  /** 로그인 또는 직전 갱신에서 받은 리프레시 토큰. */
  @IsJWT()
  refreshToken: string;
}
