import { UseStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import {
  BP_ONLY_OWNER_CODE,
  PLATFORM_PROVIDED_OWNER_CODE,
} from '../../code-groups/code-format';

export class BpCodeGroupResponseDto {
  /** 그룹 코드. @example EMP_TYPE */
  groupCode: string;
  /** 그룹명. @example 고용 형태 */
  groupName: string;
  /**
   * 관리 주체 — 늘 플랫폼제공이다. 그룹 단계에는 BP전용이 없고, 플랫폼고정 그룹은 BP 화면에 보이지 않는다(목록 ·
   * total 에서 빠진다, 2026-10-27 사용자 결정).
   */
  @ApiProperty({ enum: [PLATFORM_PROVIDED_OWNER_CODE] })
  manageOwnerCode: string;
  /** 사용 상태(플랫폼이 정한다). BP 화면에는 사용 중인 그룹만 나오므로 늘 사용이다 — 사용중지 그룹은 목록에서 빠진다. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 표시 순서. */
  sortOrder: number;
}

export class BpCodeGroupListResponseDto {
  items: BpCodeGroupResponseDto[];
  /** 조건에 맞는 전체 건수. */
  total: number;
}

export class BpCodeItemResponseDto {
  /** 상세 코드. 등록 뒤 바뀌지 않는다. @example FULL */
  itemCode: string;
  /** 코드명. 플랫폼제공 그룹이면 이 BP 의 값(복사된 뒤 고쳤으면 고친 값)이다. @example 정직원 */
  label: string;
  /** 사용 상태. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 표시 순서. */
  sortOrder: number;
  /** 관리 주체 — 플랫폼이 등록해 복사된 코드는 플랫폼제공, 이 BP 가 더하거나 되살린 코드는 BP전용. */
  @ApiProperty({ enum: [PLATFORM_PROVIDED_OWNER_CODE, BP_ONLY_OWNER_CODE] })
  manageOwnerCode: string;
  /**
   * 플랫폼 원본이 사용중지인가(안내용). BP전용은 늘 거짓. 플랫폼제공 그룹에서 BP 는 이 값과 관계없이 사용 상태를
   * 자유롭게 바꾼다(2026-10-22 결정).
   */
  isPlatformInactive: boolean;
}

export class BpCodeItemListResponseDto {
  items: BpCodeItemResponseDto[];
  /** 전체 건수. 상세 코드는 쪽을 나누지 않는다. */
  total: number;
}
