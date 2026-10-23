import { ApiProperty } from '@nestjs/swagger';
import {
  ContractStatus,
  EmploymentStatus,
  EmploymentType,
  InvitationStatus,
  InvitationType,
  LinkHoldMismatchReason,
} from '@prisma/client';
import {
  HQ_SHARING_CONSENT_STATES,
  type HqSharingConsentState,
} from '../../admin-scope/hq-sharing';
import { STAFF_JOIN_STATES, type StaffJoinState } from '../join-state';

export class StaffMemberStoreDto {
  storeId: number;
  name: string;
  /** 공통코드 STORE_TYPE — DIRECT 직영 · FRANCHISE 가맹 */
  storeType: string;
}

export class StaffMemberInvitationDto {
  @ApiProperty({ enum: InvitationType, enumName: 'InvitationType' })
  invitationType: InvitationType;
  @ApiProperty({ enum: InvitationStatus, enumName: 'InvitationStatus' })
  status: InvitationStatus;
  /** 이 초대를 보낸 일시 */
  lastSentAt: Date;
  expiresAt: Date;
  /**
   * 가입 초대 재발송 버튼을 보일지 — 이 값 하나만 본다. 참이면 이 줄의 contract.contractId 로 근로계약 재발송(POST
   * /contracts/{contractId}/send)이 가입 초대 알림톡을 보낸다(설정 누락 503 · 그사이 바뀐 상태 409 · 발송 실패 502 는 남는다).
   * 모두 맞을 때만 참이다: 가입 전(가입 완료가 아님) · 가입 상태가 초대 발송 · 초대 만료 · 소속 추가 확인 · 복귀 확인(연결 보류 ·
   * 만 19세 미만 · 거절 · 초안은 거짓) · 이 초대가 수락되지 않음 · 최근 계약이 발송 대기 또는 서명 대기 · 그 번호에 탈퇴하지
   * 않은 계정이 없음(있으면 소속 추가 확인 · 복귀 확인이라 앱에 받을 길이 없어 409) · 휴대폰 번호. 간격 제한은 없다. 가입한
   * 직원의 앱 알림 재발송은 가입 초대가 아니라 근로계약 상세에서 하므로 거짓이다.
   */
  canResend: boolean;
}

/** 미처리 연결 보류. 인증된 번호의 끝 4자리와 불일치 사유만 담는다. */
export class StaffMemberLinkHoldDto {
  linkHoldId: number;
  @ApiProperty({
    enum: LinkHoldMismatchReason,
    enumName: 'LinkHoldMismatchReason',
  })
  mismatchReason: LinkHoldMismatchReason;
  /** 가입자가 본인인증한 번호의 끝 4자리 */
  verifiedPhoneLast4: string;
  heldAt: Date;
}

/** 가장 최근 근로계약 */
export class StaffMemberContractDto {
  contractId: number;
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  status: ContractStatus | null;
  signDeadlineAt: Date | null;
  /** 계약 종료일(YYYY-MM-DD). 비면 무기한 */
  endDate: string | null;
  /** 최종 수정 일시. 거부일을 따로 저장하지 않아 「거부 · MM-DD」는 이 값으로 보인다 */
  updatedAt: Date | null;
}

/**
 * 직원 목록 한 줄. isMasked 면 본사 제공 동의가 없는 가맹 점포 직원이고, isMasked · store 밖의 칸은
 * staffMemberId 까지 모두 null 이다. 가린 줄을 어떻게 그릴지는 화면이 정한다.
 */
export class StaffMemberListItemDto {
  staffMemberId: number | null;
  isMasked: boolean;
  name: string | null;
  phone: string | null;
  store: StaffMemberStoreDto;
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  @ApiProperty({
    enum: STAFF_JOIN_STATES,
    enumName: 'StaffJoinState',
    nullable: true,
  })
  joinState: StaffJoinState | null;
  invitation: StaffMemberInvitationDto | null;
  linkHold: StaffMemberLinkHoldDto | null;
  contract: StaffMemberContractDto | null;
  @ApiProperty({
    enum: EmploymentStatus,
    enumName: 'EmploymentStatus',
    nullable: true,
  })
  employmentStatus: EmploymentStatus | null;
  /** 퇴직일(YYYY-MM-DD). 재직이면서 값이 있으면 퇴직 예정 */
  retiredDate: string | null;
}

/** 재직 기간 하나 — 재입사로 이은 다른 직원 레코드(WHALEERP-615) */
export class StaffMemberEmploymentPeriodDto {
  staffMemberId: number;
  /** 입사일(YYYY-MM-DD). 채우기 전 레코드는 null */
  hiredDate: string | null;
  /** 퇴직일(YYYY-MM-DD) — 퇴직 예정이면 정한 날. 정하지 않았으면 null */
  retiredDate: string | null;
}

/**
 * 직원 상세(GET /staff-members/:id). 목록 한 줄에 계정 이메일 · 기본 정보 칸을 더한다 — 목록에는 싣지 않는다.
 */
export class StaffMemberDetailResponseDto extends StaffMemberListItemDto {
  /**
   * 직원 계정의 현재 이메일(회원 ID · 로그인 아이디). 근무지에 직접 와서 물은 직원에게 관리자가 알려 줄 수 있게, 상세를
   * 볼 수 있는 관리자(직원 정보 관리 조회 권한)에게 낸다. 본사 역할(BM · BA)이 동의로만 보는 가맹 점포 직원이거나,
   * 가입 전 · 탈퇴 계정 · 퇴직 레코드면 null. 관리자는 고치지 못한다(관리자 요청에 email 칸이 없다).
   */
  email: string | null;
  /** 직무 */
  jobTitle: string;
  /** 입사일(YYYY-MM-DD) — 그 점포에서 처음 체결 완료된 근로계약의 시작일. 채우기 전 레코드는 null */
  hiredDate: string | null;
  /**
   * 생년월일(YYYY-MM-DD). 가입한 계정 값이고, 가입 전 · 탈퇴 계정이면 생년월일이 적힌 가장 최근 계약의 값이다. 둘 다 없으면
   * null
   */
  birthDate: string | null;
  /**
   * 본사 제공 동의 상태 — 가맹 점포 직원만 동의 · 미동의, 직영 점포 직원은 null. 계정의 동의 칸이라 철회하면 바로
   * 미동의이고, 가입 전(계정 없음)은 미동의다. 본사 역할(BM · BA)은 미동의 직원의 상세를 열지 못한다(404, ATT-30)
   */
  @ApiProperty({
    enum: HQ_SHARING_CONSENT_STATES,
    enumName: 'HqSharingConsentState',
    nullable: true,
  })
  hqSharingConsent: HqSharingConsentState | null;
  /**
   * 이전 재직 기간 — 퇴직 뒤 같은 점포에 다시 입사해 이은 옛 레코드들(WHALEERP-615), 가까운 것부터. 누르면 그 레코드의
   * 상세로 간다. 체결 완료된 계약이 없는 레코드와 이 관리자에게 가려지는 레코드는 빠진다
   */
  previousRecords: StaffMemberEmploymentPeriodDto[];
  /**
   * 이후 재직 기간 — 이 레코드 뒤에 다시 입사한 레코드들, 가까운 것부터. 체결 완료 전(임시저장 · 발송만 한) 레코드와 가려지는
   * 레코드는 빠진다
   */
  laterRecords: StaffMemberEmploymentPeriodDto[];
}

export class StaffMemberListResponseDto {
  items: StaffMemberListItemDto[];
  total: number;
}
