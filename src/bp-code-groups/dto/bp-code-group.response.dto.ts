import { UseStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import {
  BP_ONLY_OWNER_CODE,
  PLATFORM_OWNER_CODES,
} from '../../code-groups/code-format';

export class BpCodeGroupResponseDto {
  /** 그룹 코드. @example EMP_TYPE */
  groupCode: string;
  /** 그룹명. @example 고용 형태 */
  groupName: string;
  /** 관리 주체. 그룹 단계에는 BP전용이 없다 — 플랫폼고정은 조회만, 플랫폼제공은 상세 코드를 고치고 더한다. */
  @ApiProperty({ enum: PLATFORM_OWNER_CODES })
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
  /** 관리 주체 — 플랫폼이 등록한 코드는 그룹의 관리 주체, 이 BP 가 더한 코드는 BP전용. */
  @ApiProperty({ enum: [...PLATFORM_OWNER_CODES, BP_ONLY_OWNER_CODE] })
  manageOwnerCode: string;
  /**
   * 플랫폼 원본이 사용중지인가(안내용). BP전용은 늘 거짓. 플랫폼제공 그룹에서 BP 는 이 값과 관계없이 사용 상태를
   * 자유롭게 바꾼다(2026-10-22 결정). 플랫폼고정 그룹은 모든 칸이 읽기 전용이다.
   */
  isPlatformInactive: boolean;
}

export class BpCodeItemListResponseDto {
  items: BpCodeItemResponseDto[];
  /** 전체 건수. 상세 코드는 쪽을 나누지 않는다. */
  total: number;
}
