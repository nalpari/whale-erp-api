import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 비밀번호 찾기. 세 값이 모두 맞는 사용 중 계정에만 임시 비밀번호를 보낸다. */
export class AdminTemporaryPasswordDto {
  /** @example 홍길동 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  name: string;

  /** @example whale01 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  loginId: string;

  /** 저장값은 소문자다(admin_accounts_email_lower). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}
