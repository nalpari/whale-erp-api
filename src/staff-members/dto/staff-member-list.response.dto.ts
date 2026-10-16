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
   * 직원 계정의 현재 이메일(로그인 아이디). 재설정 링크가 가는 곳이다. 가입 전 · 탈퇴 계정이면 null.
   * 화면에서 고치지 못한다.
   */
  email: string | null;
}

export class StaffMemberListResponseDto {
  items: StaffMemberListItemDto[];
  total: number;
}
