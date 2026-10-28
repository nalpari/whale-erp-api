import { ApiProperty } from '@nestjs/swagger';
import { BP_STATUSES } from './list-bp-masters.dto';

export class BpMasterSummaryResponseDto {
  bpCodeId: number;
  /** BP 코드. @example BP000012 */
  bpCode: string;
  /** BP 마스터 아이디. 탈퇴해도 남는다. @example hangang01 */
  loginId: string;
  /** BP 마스터 이름 · 연락처 · 이메일. 탈퇴한 BP 는 null — 화면은 「탈퇴로 삭제됨」. */
  name: string | null;
  phone: string | null;
  email: string | null;
  /** BP 상태. 사용 · 미사용 · 탈퇴. */
  @ApiProperty({ enum: BP_STATUSES })
  accountStatus: string;
  /** 상호명 */
  tradeName: string;
  /** 사업자등록번호(숫자 10자리). 미인증이면 null. */
  bizRegistrationNumber: string | null;
  /** 가입경로. 회원가입 · 플랫폼등록. */
  @ApiProperty({ enum: ['SIGNUP', 'PLATFORM_REGISTERED'] })
  joinPath: string;
  /** 등록 일시 */
  createdAt: Date;
  /** 등록자 이름. 회원가입한 BP 는 null. */
  createdByName: string | null;
}

export class BpMasterListResponseDto {
  items: BpMasterSummaryResponseDto[];
  /** 조건에 맞는 전체 건수 */
  total: number;
}

export class BpMasterDeletionResponseDto {
  /** 지금 지울 수 있는가 */
  isDeletable: boolean;
  /** 지울 수 없는 이유. 화면 말풍선에 그대로 보인다. 지울 수 있으면 빈 배열. */
  reasons: string[];
}

export class BpMasterWithdrawalResponseDto {
  /** 탈퇴 일시 — 탈퇴로 BP 마스터 계정 상태가 바뀐 시각. 기록이 없으면 null(탈퇴 흐름은 늘 채운다). */
  withdrawnAt: Date | null;
  /** 탈퇴 사유 한글(공통코드 WITHDRAW_REASON). 표에 없는 코드는 코드 그대로, 사유 코드가 없으면 null. @example 폐업·사업 종료 */
  reasonLabel: string | null;
  /** 직접 입력한 사유. 직접입력이 아니면 null. */
  reasonDetail: string | null;
}

export class BpMasterDetailResponseDto extends BpMasterSummaryResponseDto {
  /** BP 마스터 계정 id */
  adminAccountId: number;
  /** BP 상태가 바뀐 일시 — 미사용이면 「언제부터 미사용」. 바뀐 적이 없으면 null. */
  statusChangedAt: Date | null;
  /** 대표자명 · 개업일자(YYYY-MM-DD) — 사업자 진위확인 결과. 미인증이면 null. */
  bizCeoName: string | null;
  bizOpenDate: string | null;
  bizCeoPhone: string | null;
  bizCeoEmail: string | null;
  bizZipCode: string | null;
  bizAddress: string | null;
  bizAddressDetail: string | null;
  bizCategory: string | null;
  bizItem: string | null;
  /** 최종 인증 일시. null 이면 미인증. */
  bizVerifiedAt: Date | null;
  /** 소속 점포 수 — 폐점 · 삭제한 점포는 세지 않는다. */
  storeCount: number;
  /** 하위 관리자 수 — 이 BP 의 BP 관리자 · 가맹 마스터 · 가맹 관리자 중 지우지 않은 계정. */
  subAdminCount: number;
  /** 최근 로그인. 없으면 null. */
  lastLoginAt: Date | null;
  /** 약관 동의 일시. 플랫폼등록 BP 는 첫 로그인 전까지 null. */
  termsAgreedAt: Date | null;
  /** 강제 비밀번호 변경 대상 */
  isPasswordChangeRequired: boolean;
  /** 초기 비밀번호 미발송 — 등록 · 초기화 메일이 실패했다. 비밀번호 초기화로 다시 보낸다. */
  isInitialPasswordUnsent: boolean;
  /** 최종수정 일시 — BP 나 BP 마스터 계정을 마지막으로 고친 시각(bp_codes.updated_at). */
  updatedAt: Date;
  /** 최종수정자 이름. 고친 적이 없거나 회원가입 그대로면 null. */
  updatedByName: string | null;
  deletion: BpMasterDeletionResponseDto;
  /** 탈퇴 정보 — 탈퇴한 BP 만, 아니면 null. 화면 「사유 보기」 팝업이 쓴다. */
  @ApiProperty({ type: BpMasterWithdrawalResponseDto, nullable: true })
  withdrawal: BpMasterWithdrawalResponseDto | null;
}

export class BpMasterHistoryResponseDto {
  changedAt: Date;
  /** 변경 항목. @example 상호명 */
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  /** 처리자 이름. 시스템이 처리했으면 null. */
  changedByName: string | null;
  /** 비고 — 사업자 번호 인증으로 바뀐 줄의 「사업자 번호 인증」. 탈퇴한 BP 는 이력을 409 로 거절하므로 탈퇴 사유는 상세의 withdrawal 로 본다. */
  note: string | null;
}

export class BpMasterHistoryListResponseDto {
  items: BpMasterHistoryResponseDto[];
  total: number;
}

export class BpMasterBusinessVerificationResponseDto {
  /** 10분짜리 토큰. 등록 · 수정 저장에 실어야 반영된다. */
  verificationToken: string;
}

export class CreateBpMasterResponseDto {
  bpCodeId: number;
  /** 새 BP 코드. @example BP000013 */
  bpCode: string;
  /** 초기 비밀번호를 보낸 주소 */
  email: string;
  /** 초기 비밀번호 메일을 보냈는가. 실패해도 BP 는 만들어졌다 — 상세에서 비밀번호 초기화로 다시 보낸다. */
  isMailSent: boolean;
}

export class ResetBpMasterPasswordResponseDto {
  /** 초기화 메일을 보냈는가. 실패해도 기존 비밀번호는 이미 막혔다 — 다시 초기화한다. */
  isMailSent: boolean;
}
