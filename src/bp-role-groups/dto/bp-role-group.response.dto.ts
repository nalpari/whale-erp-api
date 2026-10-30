import { ApiProperty } from '@nestjs/swagger';
import {
  PlatformRoleGroupSummaryResponseDto,
  RoleGroupMenuTreeResponseDto,
} from '../../platform-role-groups/dto/platform-role-group.response.dto';
import {
  ROLE_GROUP_LOCK_REASONS,
  type RoleGroupLockReason,
} from '../../platform-role-groups/platform-role-group-format';
import {
  BP_ROLE_GROUP_TYPES,
  BP_ROLE_TREE_TYPES,
  type BpRoleType,
} from '../bp-role-group-access';

/** 가맹 관리자 그룹을 만든 가맹 마스터. */
export class BpRoleGroupManagerResponseDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
}

/** 플랫폼 목록 항목과 같고 유형 · 관리계정 · 본인 연결 · 메뉴 수를 더한다. isMaster 는 늘 false 다. */
export class BpRoleGroupSummaryResponseDto extends PlatformRoleGroupSummaryResponseDto {
  /** 권한 유형 — BP 관리자 BA · 가맹 관리자 FA. 한글은 공통코드 ROLE_TYPE. */
  @ApiProperty({ enum: [...BP_ROLE_GROUP_TYPES] })
  declare roleTypeCode: string;
  /** 관리계정 — FA 그룹을 만든 가맹 마스터. BA 는 null. */
  manager: BpRoleGroupManagerResponseDto | null;
  /** 호출자 본인이 연결된 그룹인가 — 「본인」 배지. */
  isSelfLinked: boolean;
  /** 조회가 켜진 메뉴 수(묶음 메뉴 포함) — 「등록 N개」. 0 이면 「미등록」. */
  menuCount: number;
}

export class BpRoleGroupListResponseDto {
  /** 권한 코드 순(BA 다음 FA). 고정 권한 · 지운 그룹은 싣지 않는다. */
  items: BpRoleGroupSummaryResponseDto[];
  total: number;
  /**
   * 이 호출자가 등록할 때 만들어지는 유형 — BP 마스터 BA, 가맹 마스터 FA, 나머지 null(등록 불가). 메뉴 등록 권한은
   * 보지 않는다 — 화면은 메뉴 권한과 합쳐 버튼을 보인다.
   */
  @ApiProperty({ enum: [...BP_ROLE_GROUP_TYPES], nullable: true })
  creatableRoleTypeCode: BpRoleType | null;
}

export class BpRoleGroupDetailResponseDto extends BpRoleGroupSummaryResponseDto {
  /**
   * 역할로 권한명 · 설명을 고칠 수 있는가 — BM 은 그 BP 의 BA, FM 은 본인 FA. 본인이 연결된 그룹도 고친다(재영
   * 2026-10-30). false 의 이유는 editBlockedReason. 메뉴 칸은 메뉴 트리의 칸별 값을 본다(본인 연결은 거기서 막힌다).
   */
  isEditable: boolean;
  /** 고칠 수 없는 이유. 한글은 GET /enums/PlatformRoleGroupLockReason. */
  @ApiProperty({
    enum: ROLE_GROUP_LOCK_REASONS,
    enumName: 'PlatformRoleGroupLockReason',
    nullable: true,
  })
  editBlockedReason: RoleGroupLockReason | null;
  /**
   * 역할로 지울 수 있고 본인이 연결된 그룹도 아닌가. false 의 이유는 deleteBlockedReason. 연결 사용자가 있는데 대체
   * 후보가 없는 것은 삭제 후보 조회로 알린다.
   */
  isDeletable: boolean;
  @ApiProperty({
    enum: ROLE_GROUP_LOCK_REASONS,
    enumName: 'PlatformRoleGroupLockReason',
    nullable: true,
  })
  deleteBlockedReason: RoleGroupLockReason | null;
}

/** 플랫폼 메뉴 트리와 같은 모양. 가맹마스터 보기는 FM000001 을 돌려준다. */
export class BpRoleGroupMenuTreeResponseDto extends RoleGroupMenuTreeResponseDto {
  @ApiProperty({ enum: [...BP_ROLE_TREE_TYPES] })
  declare roleTypeCode: string;
}
