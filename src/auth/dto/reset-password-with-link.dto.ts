import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResetPasswordWithLinkDto {
  /** 메일 링크 fragment(`#token=`)의 token 값 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;

  /**
   * 새 비밀번호. 문자 종류와 길이 규칙은 서버가 검사하고 어긋나면 사유를 준다(링크는 그대로). 여기서는 터무니없이
   * 긴 입력(scrypt 에 큰 값을 먹이는 일)만 막는다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword: string;
}
