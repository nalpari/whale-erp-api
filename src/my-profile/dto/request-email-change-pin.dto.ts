import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/** 이메일 변경 핀 요청 (WHALEERP-191) */
export class RequestEmailChangePinDto {
  /** 바꿀 새 이메일. 대소문자는 가리지 않고 소문자로 저장한다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  newEmail: string;
}
