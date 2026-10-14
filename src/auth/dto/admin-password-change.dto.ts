import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** 강제 비밀번호 변경. 현재 비밀번호는 묻지 않는다(1팀 S-VFGQLI). */
export class AdminPasswordChangeDto {
  /** 새 비밀번호 — 영문 · 숫자 · 특수문자 각 1자 이상 8~20자. 규칙 위반은 400 과 정책 문구 하나. */
  @IsString()
  // 정책 검사 전에 터무니없이 긴 값이 scrypt 에 닿지 않게만 막는다. 20자 규칙은 서비스가 정책 문구로 알린다.
  @MaxLength(100)
  newPassword: string;

  /** 새 비밀번호 확인. */
  @IsString()
  @MaxLength(100)
  newPasswordConfirm: string;

  /**
   * 필수 약관(이용약관 · 개인정보 수집 · 이용) 둘 다 동의. `login-info.account.isTermsAgreementRequired` 가 true 인
   * 계정만 보내고, 그때 true 가 아니면 비밀번호도 바꾸지 않고 400 이다.
   */
  @IsOptional()
  @IsBoolean()
  isTermsAgreed?: boolean;
}
