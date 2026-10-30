import { ApiProperty } from '@nestjs/swagger';
import {
  PLATFORM_ROLE_GROUP_TYPES,
  ROLE_GROUP_LOCK_REASONS,
  type RoleGroupLockReason,
} from '../platform-role-group-format';
import { type CellBlockReason, MENU_BLOCK_REASONS } from '../role-menu-rules';

/** 등록자 · 수정자. 시스템(마이그레이션)이 넣은 행이면 null. */
export class RoleGroupActorResponseDto {
  name: string | null;
  loginId: string;
}

export class PlatformRoleGroupSummaryResponseDto {
  roleGroupId: number;
  /** 권한 코드 — 유형 + 6자리. @example PA000002 */
  roleCode: string;
  /** 권한 유형 — 플랫폼 마스터 PM · 플랫폼 관리자 PA · BP 마스터 BM · 가맹 마스터 FM. 한글은 공통코드 ROLE_TYPE. */
  @ApiProperty({ enum: [...PLATFORM_ROLE_GROUP_TYPES] })
  roleTypeCode: string;
  /** 권한명. @example 고객지원 담당 */
  name: string;
  description: string | null;
  /** 고정 권한(PM000001 · BM000001 · FM000001 같은 마이그레이션 시드). 지울 수 없다. */
  isMaster: boolean;
  /** 메뉴 등록 여부 — 서비스와 관계없이 조회가 켜진 메뉴가 하나라도 있으면 true. 아니면 「미등록」. */
  isMenuRegistered: boolean;
  createdAt: Date;
  createdBy: RoleGroupActorResponseDto | null;
  /** 최종수정일시. 권한명 · 설명 수정, 메뉴 저장, 삭제가 그대로 돌려보낸다(동시 수정 확인). */
  updatedAt: Date;
  updatedBy: RoleGroupActorResponseDto | null;
  /** 연결된 지우지 않은 관리자 수(미사용 포함) — 삭제 대화상자가 대체 권한을 고르게 할지 가른다. */
  adminCount: number;
}

export class PlatformRoleGroupSummaryListResponseDto {
  /** 고정 권한 PM · PA · BM · FM 다음 플랫폼 관리자 추가 권한을 코드 순으로. BP 관리자 · 가맹 관리자 그룹은 싣지 않는다. */
  items: PlatformRoleGroupSummaryResponseDto[];
  total: number;
}

export class PlatformRoleGroupDetailResponseDto extends PlatformRoleGroupSummaryResponseDto {
  /** 권한명 · 설명을 고칠 수 있는가. 본인이 연결된 권한도 고친다(재영 2026-10-30). 메뉴 칸은 메뉴 트리의 칸별 값을 본다. */
  isEditable: boolean;
  /** 고칠 수 없는 이유. 고칠 수 있으면 null. 한글은 GET /enums/PlatformRoleGroupLockReason. */
  @ApiProperty({
    enum: ROLE_GROUP_LOCK_REASONS,
    enumName: 'PlatformRoleGroupLockReason',
    nullable: true,
  })
  editBlockedReason: RoleGroupLockReason | null;
  /** 지울 수 있는가. 연결 사용자가 있는데 대체 후보가 없는 것은 삭제 후보 조회로 알린다. */
  isDeletable: boolean;
  @ApiProperty({
    enum: ROLE_GROUP_LOCK_REASONS,
    enumName: 'PlatformRoleGroupLockReason',
    nullable: true,
  })
  deleteBlockedReason: RoleGroupLockReason | null;
}

export class CreatePlatformRoleGroupResponseDto {
  roleGroupId: number;
  /** 채번한 권한 코드. @example PA000005 */
  roleCode: string;
}

/** 메뉴 칸 하나 — 현재 값과 바꿀 수 있는지. */
export class RoleGroupMenuCellResponseDto {
  value: boolean;
  /** 바꿀 수 있는가. */
  editable: boolean;
  /** 바꿀 수 없는 이유. 한글은 GET /enums/PlatformRoleMenuBlockReason. 바꿀 수 있으면 null. */
  @ApiProperty({
    enum: MENU_BLOCK_REASONS,
    enumName: 'PlatformRoleMenuBlockReason',
    nullable: true,
  })
  blockedReason: CellBlockReason | null;
}

export class RoleGroupMenuNodeResponseDto {
  menuId: number;
  /** @example MN000213 */
  menuCode: string;
  name: string;
  /** 단계 1~3 */
  depth: number;
  /** 묶음 메뉴 — 보이는 하위가 있다. 칸은 서버가 하위에서 다시 정한다(하위에 조회가 있으면 조회만). */
  isGroup: boolean;
  read: RoleGroupMenuCellResponseDto;
  create: RoleGroupMenuCellResponseDto;
  update: RoleGroupMenuCellResponseDto;
  delete: RoleGroupMenuCellResponseDto;
  children: RoleGroupMenuNodeResponseDto[];
}

export class RoleGroupMenuServiceResponseDto {
  /** 공통코드 SERVICE. @example PLATFORM */
  serviceCode: string;
  /** @example Whale ERP 플랫폼 관리 */
  name: string;
  /** 보이는 메뉴 트리. 비면 「이 서비스에 등록된 메뉴가 없습니다」. */
  menus: RoleGroupMenuNodeResponseDto[];
}

export class RoleGroupMenuTreeResponseDto {
  roleGroupId: number;
  roleCode: string;
  @ApiProperty({ enum: [...PLATFORM_ROLE_GROUP_TYPES] })
  roleTypeCode: string;
  name: string;
  /** 저장할 때 그대로 돌려보낸다. */
  updatedAt: Date;
  /**
   * 저장할 수 있는가 — 플랫폼 마스터 권한 · 권한 관리 수정 권한 없음 · 본인 연결이면 false. 칸이 본인 범위 밖으로
   * 막힌 것은 여기서 보지 않는다(칸별 blockedReason).
   */
  isSavable: boolean;
  /** 사용 중인 서비스(공통코드 SERVICE 순서)별 메뉴. 숨겨진 메뉴는 빠진다. */
  services: RoleGroupMenuServiceResponseDto[];
}

export class SaveRoleGroupMenusResponseDto {
  /** 저장 뒤 최종수정일시. 이어서 권한명 · 설명이나 메뉴를 저장할 때 이 값을 보낸다. */
  updatedAt: Date;
}

/**
 * 고정 권한에서 칸을 뺄 때 함께 빠지는 범위(저장 전 확인 창).
 * - revokedCells: 꺼지는 칸 수(메뉴 × 조회 · 등록 · 수정 · 삭제, 묶음 메뉴 포함).
 * - affectedRoleGroupCount: BP 마스터면 BP 관리자(BA), 가맹 마스터면 가맹 관리자(FA) 권한 그룹 중, 모든 BP 의
 *   지우지 않은 그룹으로서 연쇄로 실제 행이 바뀌는 그룹 수(조회를 회수하면 그 줄 전체가 꺼지므로 그것까지 본다).
 * - affectedAdminCount: 그 그룹들에 연결된 지우지 않은 관리자 수(미사용 포함) + 이 고정 권한 자신에 연결된
 *   지우지 않은 관리자 수.
 * 꺼지는 칸이 없으면 셋 다 0 이다 — 고정 권한 자신의 관리자도 세지 않는다. BP · 가맹 마스터가 아니면(플랫폼 관리자
 * 권한) 연쇄가 없어 뒤의 두 수는 0 이다.
 */
export class RoleGroupMenuRevocationPreviewResponseDto {
  revokedCells: number;
  affectedRoleGroupCount: number;
  affectedAdminCount: number;
}

export class DeletionCandidateAdminResponseDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
  /** 계정 상태 — 사용 ACTIVE · 미사용 INACTIVE */
  accountStatusCode: string;
}

export class DeletionCandidateRoleGroupResponseDto {
  roleGroupId: number;
  roleCode: string;
  name: string;
}

export class RoleGroupDeletionCandidatesResponseDto {
  /** 옮겨야 할 연결 사용자 — 지우지 않은 관리자(미사용 포함). 비어 있으면 대체 권한 없이 지운다. */
  admins: DeletionCandidateAdminResponseDto[];
  /** 대체 권한 후보 — 같은 유형(PA)의 지우지 않은 다른 추가 권한. 고정 권한은 빠진다. */
  candidates: DeletionCandidateRoleGroupResponseDto[];
}
