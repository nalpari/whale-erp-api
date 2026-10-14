import { ApiProperty } from '@nestjs/swagger';
import { ADMIN_STATUSES } from './list-platform-admins.dto';

export class PlatformRoleGroupResponseDto {
  roleGroupId: number;
  /** 권한 코드. @example PA000001 */
  roleCode: string;
  /** 권한명. @example 플랫폼 관리자 */
  name: string;
  /** 권한 유형. 플랫폼 마스터 PM · 플랫폼 관리자 PA. */
  @ApiProperty({ enum: ['PM', 'PA'] })
  roleTypeCode: string;
}

export class PlatformRoleGroupListResponseDto {
  items: PlatformRoleGroupResponseDto[];
}

export class PlatformAdminSummaryResponseDto {
  adminAccountId: number;
  /** 아이디. @example seojun01 */
  loginId: string;
  name: string | null;
  /** 사용자 권한 */
  roleGroup: PlatformRoleGroupResponseDto;
  /** 계정 상태. 사용 · 미사용. */
  @ApiProperty({ enum: ADMIN_STATUSES })
  accountStatus: string;
  phone: string | null;
  email: string | null;
  /** 최근 로그인. 없으면 null — 화면은 「로그인 기록 없음」. */
  lastLoginAt: Date | null;
  /** 등록일시 */
  createdAt: Date;
  /** 초기 비밀번호 미발송 — 계정 생성 · 초기화 메일이 실패했다. 다시 초기화하면 보낸다. */
  isInitialPasswordUnsent: boolean;
}

export class PlatformAdminListResponseDto {
  items: PlatformAdminSummaryResponseDto[];
  /** 조건에 맞는 전체 건수 */
  total: number;
  /** 검색어 · 권한 조건에 맞는 미사용 계정 수 — 목록 머리의 「미사용 N」. 상태 조건은 보지 않는다(사용만 골라도 센다) */
  inactiveCount: number;
}

export class PlatformAdminDetailResponseDto extends PlatformAdminSummaryResponseDto {
  department: string | null;
  jobTitle: string | null;
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
  /** 계정 상태가 바뀐 일시 — 미사용이면 「언제부터 미사용」 */
  statusChangedAt: Date | null;
  /** 등록자 이름. 시스템이 만든 계정이면 null. */
  createdByName: string | null;
  /** 최종수정일시. 수정할 때 그대로 돌려보낸다(동시 수정 확인). */
  updatedAt: Date;
  /** 최종수정자 이름. 등록 뒤 고친 적이 없으면 null. */
  updatedByName: string | null;
}

export class PlatformAdminHistoryResponseDto {
  changeId: number;
  /** 변경 항목. @example 계정 상태 */
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  changedAt: Date;
  /** 처리자 이름. 시스템이 처리했으면 null. */
  changedByName: string | null;
}

export class PlatformAdminHistoryListResponseDto {
  items: PlatformAdminHistoryResponseDto[];
  total: number;
}

export class CreatePlatformAdminResponseDto {
  adminAccountId: number;
  /** 초기 비밀번호 메일을 보냈는가. 실패해도 계정은 만들어졌다 — 상세에서 비밀번호 초기화로 다시 보낸다. */
  isMailSent: boolean;
}

export class ResetPasswordResponseDto {
  /** 초기화 메일을 보냈는가. 실패해도 기존 비밀번호는 이미 막혔다 — 다시 초기화한다. */
  isMailSent: boolean;
  /** 초기화 뒤의 최종수정일시. 초기화가 이 값을 올리므로, 상세 화면은 다음 수정 저장에 이 값을 쓴다. */
  updatedAt: Date;
}
