import { Transform } from 'class-transformer';
import { Matches, ValidateIf } from 'class-validator';

/** 앞뒤 공백을 지우고 대문자로 맞춘다 — 직원이 소문자로 넣어도 같은 코드다 */
const toCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
/** 화면이 넣은 하이픈 · 공백을 지운다 */
const digitsOnly = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;

/**
 * 초대를 찾는 값(진입 · 가입 화면 가이드 JOIN-7). 초대 링크로 열었으면 토큰(`/invite#token=…`), 앱을 직접 열었으면
 * 휴대전화번호와 초대 코드 — 둘 가운데 하나만 보낸다(서비스가 본다).
 */
export class InvitationLookupDto {
  /** 초대 링크의 토큰(base64url 43자) */
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: '초대 링크가 올바르지 않습니다.' })
  token?: string;

  /** 초대를 받은 휴대전화번호 — 숫자 10~11자리(하이픈은 지운다) */
  @ValidateIf((_, v) => v !== undefined)
  @Transform(digitsOnly)
  @Matches(/^[0-9]{10,11}$/, {
    message: '휴대전화번호는 숫자 10~11자리입니다.',
  })
  phone?: string;

  /** 초대 코드 — 대문자 · 숫자 8자리, 0 · O · 1 · I 는 없다. 소문자로 넣어도 대문자로 맞춰 본다 */
  @ValidateIf((_, v) => v !== undefined)
  @Transform(toCode)
  @Matches(/^[A-HJ-NP-Z2-9]{8}$/, {
    message: '초대 코드는 영문 대문자 · 숫자 8자리입니다.',
  })
  code?: string;
}
