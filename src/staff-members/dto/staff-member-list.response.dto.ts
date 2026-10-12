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
}

/**
 * 직원 목록 한 줄. isMasked 면 본사 제공 동의가 없는 가맹 점포 직원이고, staffMemberId · store 밖의 칸은 모두
 * null 이다 — 화면은 이름 자리에 「본사 제공 동의 없음 · 가맹 점포 직원」, 나머지에 「—」를 그린다.
 */
export class StaffMemberListItemDto {
  staffMemberId: number;
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
  /** 이번 주(한국 시간 월~일) 근무스케줄 합계, 휴게 뺀 분 */
  weeklyScheduledMinutes: number | null;
  @ApiProperty({
    enum: EmploymentStatus,
    enumName: 'EmploymentStatus',
    nullable: true,
  })
  employmentStatus: EmploymentStatus | null;
  /** 퇴직일(YYYY-MM-DD). 재직이면서 값이 있으면 퇴직 예정 */
  retiredDate: string | null;
}

export class StaffMemberListResponseDto {
  items: StaffMemberListItemDto[];
  total: number;
}
