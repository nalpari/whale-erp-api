import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { LOGIN_ID_PATTERN, trimText } from '../platform-admin-format';

/** 등록 화면의 아이디 중복 확인. 등록과 같은 형식 규칙으로 본다. */
export class LoginIdAvailabilityQueryDto {
  /** 아이디. 영문 또는 영문 · 숫자 4~20자. @example seojun01 */
  @Transform(trimText)
  @Matches(LOGIN_ID_PATTERN, {
    message: '아이디는 영문 또는 영문 · 숫자 조합으로 4~20자입니다.',
  })
  loginId: string;
}

export class LoginIdAvailabilityResponseDto {
  /** 쓸 수 있는가. 삭제한 계정의 아이디도 쓸 수 없다. */
  available: boolean;
}
