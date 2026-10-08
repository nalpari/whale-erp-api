import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class RequestPasswordResetPinDto {
  /** 비밀번호를 잊은 계정의 이메일. 대소문자는 구분하지 않는다. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}
