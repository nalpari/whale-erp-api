import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 비밀번호 변경 (WHALEERP-192) */
export class ChangeMyPasswordDto {
  /** 지금 비밀번호 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  /**
   * 새 비밀번호. 규칙상 20자까지이고, 문자 종류 · 길이 · 이메일 규칙은 서버가 보고 어긋나면 사유를 준다. 여기 128 은 규칙이
   * 아니라 터무니없이 긴 입력(scrypt 에 큰 값을 먹이는 일)을 막는 상한이다 — 20 으로 내리면 사유 대신 검증 문구가 나간다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword: string;
}
