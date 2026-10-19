import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** 아이디 찾기. 두 값이 모두 맞는 사용 중 계정의 아이디를 가려서 준다. */
export class AdminLoginIdFindDto {
  /** @example 홍길동 */
  @Transform(trim)
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
