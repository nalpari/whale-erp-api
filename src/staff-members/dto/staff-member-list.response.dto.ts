import { ApiProperty } from '@nestjs/swagger';
import {
  ContractStatus,
  EmploymentStatus,
  EmploymentType,
  InvitationStatus,
  InvitationType,
  LinkHoldMismatchReason,
} from '@prisma/client';
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
  /** 재발송 버튼을 보일지. 간격 제한 없이 상태로만 정한다 — 초대 발송 · 초대 만료 · 소속 추가 확인 · 복귀 확인 */
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

/**
 * 직원 상세(GET /staff-members/:id). 목록 한 줄에 계정 이메일을 더한다 — 목록에는 싣지 않는다.
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
  /** 입사일(YYYY-MM-DD). 아직 채우는 곳이 없어 비어 있을 수 있다 */
  hiredDate: string | null;
  /**
   * 생년월일(YYYY-MM-DD). 가입한 계정 값이고, 가입 전 · 탈퇴 계정이면 가장 최근 계약에 관리자가 적은 값이다. 둘 다 없으면
   * null
   */
  birthDate: string | null;
}

export class StaffMemberListResponseDto {
  items: StaffMemberListItemDto[];
  total: number;
}
