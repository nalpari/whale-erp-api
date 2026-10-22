import { UseStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class BpCodeGroupResponseDto {
  /** 그룹 코드. @example EMP_TYPE */
  groupCode: string;
  /** 그룹명. @example 고용 형태 */
  groupName: string;
  /** 관리 주체. 그룹 단계에는 BP전용이 없다 — 플랫폼고정은 조회만, 플랫폼제공은 상세 코드를 고치고 더한다. */
  @ApiProperty({ enum: ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'] })
  manageOwnerCode: string;
  /** 사용 상태(플랫폼이 정한다). 사용중지 그룹은 상세 코드를 더하거나 고칠 수 없다. */
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
  /** 코드명. 플랫폼제공 그룹이면 이 BP 가 고친 값이다. @example 정직원 */
  label: string;
  /** 사용 상태. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 표시 순서. */
  sortOrder: number;
  /** 관리 주체 — 플랫폼이 등록한 코드는 그룹의 관리 주체, 이 BP 가 더한 코드는 BP전용. */
  @ApiProperty({ enum: ['PLATFORM_FIXED', 'PLATFORM_PROVIDED', 'BP_ONLY'] })
  manageOwnerCode: string;
  /**
   * 플랫폼 원본이 사용중지인가. BP전용은 늘 거짓. 참이면서 지금 사용중지인 코드는 BP 가 사용으로 켤 수 없다(409).
   * 참이어도 지금 사용 중인 코드는 끌 수 있고 그대로 저장해도 된다 — 화면은 「참이고 사용중지일 때」만 켜기를 막는다.
   */
  isPlatformInactive: boolean;
}

export class BpCodeItemListResponseDto {
  items: BpCodeItemResponseDto[];
  /** 전체 건수. 상세 코드는 쪽을 나누지 않는다. */
  total: number;
}
