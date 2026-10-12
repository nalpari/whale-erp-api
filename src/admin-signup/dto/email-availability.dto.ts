import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class EmailAvailabilityDto {
  /** 가입 화면의 이메일. 가입과 같이 소문자로 정규화해 본다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: '이메일 형식으로 입력해 주세요.' })
  @MaxLength(254)
  email: string;
}
