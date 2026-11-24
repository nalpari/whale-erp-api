import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 직원 앱 회원 탈퇴 (WHALEERP-770) */
export class WithdrawMyAccountDto {
  /** 지금 비밀번호 — 재확인. 틀려도 로그인 실패 횟수는 세지 않는다 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;
}
