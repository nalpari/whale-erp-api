import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { WITHDRAW_REASON_CODES } from '../admin-withdrawal.service';

/** 회원 탈퇴 실행(마이페이지, S-JHQQNR). BP 마스터 본인이 현재 비밀번호와 탈퇴 사유를 보낸다. */
export class CreateWithdrawalDto {
  /** 현재 비밀번호. */
  @IsString()
  // 터무니없이 긴 값이 scrypt 에 닿지 않게만 막는다 — 내 비밀번호 변경과 같다.
  @MaxLength(100)
  currentPassword: string;

  /** 탈퇴 사유 — 공통코드 WITHDRAW_REASON. */
  @IsIn(WITHDRAW_REASON_CODES)
  reasonCode: string;

  /** 탈퇴 사유 상세 — 직접입력(WD_INPUT)일 때 필수. 그 검사는 서비스에서 한다. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonDetail?: string;
}
