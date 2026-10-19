import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 아이디 찾기. 비밀번호 찾기(AdminTemporaryPasswordDto)와 같은 규칙으로 이름 · 이메일을 맞춘다. */
export class AdminLoginIdFindDto {
  /** 앞뒤 공백은 무시하고, 한글 자모가 풀려 와도(NFD) 같은 이름으로 본다. @example 홍길동 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  name: string;

  /** 저장값은 소문자다(admin_accounts_email_lower). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}
