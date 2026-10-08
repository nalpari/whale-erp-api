import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** 핀 확인에 쓴 핀을 다시 보낸다. 서버가 한 번 더 검증한다. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  pin: string;

  /**
   * 새 비밀번호. 문자 종류와 길이 규칙은 서버가 검사하고 어긋나면 사유를 준다. 여기서는 터무니없이
   * 긴 입력(scrypt 에 큰 값을 먹이는 일)만 막는다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword: string;
}
