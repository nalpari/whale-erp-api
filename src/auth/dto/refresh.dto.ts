import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshDto {
  /** 로그인 응답으로 받은 갱신 토큰. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken: string;
}
