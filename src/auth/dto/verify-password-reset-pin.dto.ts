import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyPasswordResetPinDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** 메일로 받은 핀. 앞뒤 공백과 대소문자는 서버가 정리한다. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  pin: string;
}
