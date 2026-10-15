import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

export class LoginIdAvailabilityDto {
  /** 가입 화면의 아이디. 가입과 같이 소문자로 정규화해 본다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(/^(?=.*[a-z])[a-z0-9]{4,20}$/, {
    message: '영문·숫자 조합으로 4~20자로 입력해 주세요.',
  })
  loginId: string;
}
