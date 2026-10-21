import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';
import {
  lowerEmail,
  NAME_PATTERN,
  PHONE_PATTERN,
  trimText,
} from '../../platform-admins/platform-admin-format';

/**
 * 내 기본정보 수정(S-JXKHCM). 이름 · 연락처 · 이메일만 받는다 — 아이디 · 사용자 권한 ·
 * 가입일 · 최근 로그인 일시는 이 화면에서 바꾸지 않는다. 형식 규칙은 관리자 등록 · 수정
 * (platform-admins)과 같다 — 같은 admin_accounts 테이블의 CHECK 제약이라 같은 정규식을 쓴다.
 */
export class AdminProfileUpdateDto {
  /** 이름. 한글 · 영문 2~20자. @example 이서준 */
  @Transform(trimText)
  @Matches(NAME_PATTERN, { message: '이름은 한글 또는 영문 2~20자입니다' })
  name: string;

  /** 연락처. 하이픈 없이 숫자 10~11자리. @example 01012345678 */
  @Matches(PHONE_PATTERN, { message: '연락처는 숫자 10~11자리입니다' })
  phone: string;

  /** 이메일. 소문자로 저장한다. 원래 값과 같으면 중복 검사를 하지 않는다. @example seojun@whale.test */
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다' })
  @MaxLength(100)
  email: string;
}
