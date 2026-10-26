import { IsString, MaxLength } from 'class-validator';

/** 내 비밀번호 변경(MY PAGE, 1팀 S-PTWREE). 강제 비밀번호 변경(AdminPasswordChangeDto)과 달리 현재 비밀번호를 받는다. */
export class AdminMyPasswordChangeDto {
  /** 현재 비밀번호. */
  @IsString()
  // 정책 검사 전에 터무니없이 긴 값이 scrypt 에 닿지 않게만 막는다.
  @MaxLength(100)
  currentPassword: string;

  /** 새 비밀번호 — 영문 · 숫자 · 특수문자 각 1자 이상 8~20자. 규칙 위반은 400 과 정책 문구 하나. */
  @IsString()
  @MaxLength(100)
  newPassword: string;

  /** 새 비밀번호 확인. */
  @IsString()
  @MaxLength(100)
  newPasswordConfirm: string;
}
