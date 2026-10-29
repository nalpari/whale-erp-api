import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
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
  @Matches(NAME_PATTERN, { message: '이름은 한글 또는 영문 2~20자입니다.' })
  name: string;

  /** 연락처. 하이픈 없이 숫자 9~12자리. @example 01012345678 */
  @Matches(PHONE_PATTERN, { message: '연락처는 숫자 9~12자리입니다.' })
  phone: string;

  /** 이메일. 소문자로 저장한다. 원래 값과 같으면 중복 검사를 하지 않는다. @example seojun@whale.test */
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다.' })
  @MaxLength(100)
  email: string;

  /** 내 정보 조회 응답의 updatedAt 그대로. 그사이 다른 관리자가 이 계정을 고쳤으면 409
   * (platform-admins update 와 같은 동시 수정 검사 — 코드 리뷰로 찾음, 2026-10-21. 전에는
   * 이 칸이 없어 동시에 고치면 먼저 연 쪽이 조용히 덮어썼다). */
  @IsUpdatedAt()
  updatedAt: string;
}
