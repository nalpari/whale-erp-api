import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyPasswordResetLinkDto {
  /** 메일 링크의 token 쿼리 값. 모양이 틀려도 400 이 아니라 쓸 수 없는 링크(401)다. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;
}
