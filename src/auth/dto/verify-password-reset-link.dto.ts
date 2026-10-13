import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyPasswordResetLinkDto {
  /**
   * 메일 링크 fragment(`#token=`)의 token 값. base64url 모양이 아니어도 400 이 아니라 쓸 수 없는 링크(401)다. 비었거나
   * 문자열이 아니거나 200자를 넘으면 검증 단계의 400 이다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;
}
