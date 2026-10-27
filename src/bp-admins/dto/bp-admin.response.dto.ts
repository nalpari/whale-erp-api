import { ApiProperty } from '@nestjs/swagger';
import {
  ADMIN_STATUSES,
  type AdminStatus,
} from '../../platform-admins/dto/list-platform-admins.dto';
import { BP_ADMIN_ROLES, type BpAdminRole } from '../bp-admin-rules';
import { STORE_TYPES, type StoreType } from './list-bp-admins.dto';

export class BpAdminRoleGroupDto {
  roleGroupId: number;
  /** 권한 코드. @example BA000003 */
  roleCode: string;
  name: string;
  @ApiProperty({ enum: BP_ADMIN_ROLES, enumName: 'BpAdminRole' })
  roleTypeCode: BpAdminRole;
}

export class BpAdminRoleGroupListResponseDto {
  items: BpAdminRoleGroupDto[];
}

export class BpAdminSummaryResponseDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
  @ApiProperty({ enum: BP_ADMIN_ROLES, enumName: 'BpAdminRole' })
  roleTypeCode: BpAdminRole;
  roleGroup: BpAdminRoleGroupDto;
  @ApiProperty({ enum: ADMIN_STATUSES, enumName: 'AdminAccountStatus' })
  accountStatus: AdminStatus;
  /** 전체 점포 담당. true 면 storeCount 는 0 */
  isAllStores: boolean;
  /** 매핑 점포 수(지운 점포 제외) */
  storeCount: number;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** 초기 비밀번호 미발송 — 등록 · 초기화 메일이 나가지 못했다. [비밀번호 초기화]로 다시 보낸다 */
  isInitialPasswordUnsent: boolean;
}

export class BpAdminListResponseDto {
  items: BpAdminSummaryResponseDto[];
  total: number;
  /** 상태 조건과 관계없이 같은 조건의 미사용 계정 수 */
  inactiveCount: number;
}

export class BpAdminStoreDto {
  storeId: number;
  storeCode: string;
  name: string;
  /** 공통코드 STORE_STATUS — NOT_OPERATING · OPERATING · CLOSED */
  storeStatusCode: string;
  /** 보는 사람의 관리 범위 밖 — 수정에서 「범위 밖 매핑」으로 읽기 전용, 저장해도 남는다 */
  isOutOfScope: boolean;
}

export class BpAdminAccountRefDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
}

export class BpAdminActionsDto {
  isSelf: boolean;
  canUpdate: boolean;
  canResetPassword: boolean;
  canChangeScope: boolean;
  canChangeRoleGroup: boolean;
}

export class BpAdminDetailResponseDto extends BpAdminSummaryResponseDto {
  phone: string | null;
  email: string | null;
  statusChangedAt: Date | null;
  createdByName: string | null;
  updatedAt: Date;
  updatedByName: string | null;
  /** 이 BP 의 지우지 않은 점포 수 — 「전체 점포 — 지금 N개점」 */
  bpStoreCount: number;
  /** 일부 점포일 때 매핑 점포, 이름순 */
  stores: BpAdminStoreDto[];
  /** 가맹 관리자의 연결 가맹 마스터. 다른 역할은 null */
  franchiseMaster: BpAdminAccountRefDto | null;
  /** 역할 규칙으로 정한 버튼. 메뉴 권한(수정)은 화면이 함께 본다 */
  actions: BpAdminActionsDto;
}

export class BpAdminStoreOptionDto {
  storeId: number;
  storeCode: string;
  name: string;
  @ApiProperty({ enum: STORE_TYPES, enumName: 'StoreType' })
  storeTypeCode: StoreType;
  /** NOT_OPERATING · OPERATING — 폐점은 선택지에 없다 */
  storeStatusCode: string;
}

export class BpAdminStoreOptionListResponseDto {
  items: BpAdminStoreOptionDto[];
}

export class BpAdminHistoryResponseDto {
  changeId: number;
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  changedAt: Date;
  changedByName: string | null;
}

export class BpAdminHistoryListResponseDto {
  items: BpAdminHistoryResponseDto[];
  total: number;
}

export class BpAdminUpdateImpactResponseDto {
  /** 함께 미사용이 되는 사용 중 가맹 관리자 수 */
  deactivatedCount: number;
  firstDeactivatedLoginId: string | null;
  /** 점포 매핑이 빠지는 가맹 관리자 수 */
  unmappedCount: number;
  firstUnmappedLoginId: string | null;
}

export class CreateBpAdminResponseDto {
  adminAccountId: number;
  /** 초기 비밀번호 메일을 보냈는가. false 면 계정은 남고 「미발송」으로 보인다 */
  isMailSent: boolean;
}

export class ResetBpAdminPasswordResponseDto {
  isMailSent: boolean;
  /** 초기화가 올린 최종수정일시 — 다음 저장의 updatedAt 으로 쓴다 */
  updatedAt: Date;
}
