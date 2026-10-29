import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 현재 비밀번호 확인(MY PAGE 회원 탈퇴 1단계, S-JHQQNR). */
export class AdminPasswordVerificationDto {
  /** 현재 비밀번호. */
  @IsString()
  @IsNotEmpty()
  // 터무니없이 긴 값이 scrypt 에 닿지 않게만 막는다(내 비밀번호 변경과 같다).
  @MaxLength(100)
  currentPassword: string;
}
