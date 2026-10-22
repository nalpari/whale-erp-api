import { UseStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { PLATFORM_OWNER_CODES } from '../code-format';

export class CodeGroupResponseDto {
  /** 그룹 코드. @example EMP_TYPE */
  groupCode: string;
  /** 그룹명. @example 고용 형태 */
  groupName: string;
  /** 관리 주체. 공통코드 MANAGE_OWNER 값. */
  @ApiProperty({ enum: PLATFORM_OWNER_CODES })
  manageOwnerCode: string;
  /** BP 적용 여부. 플랫폼제공 그룹만 의미가 있다. */
  isBpApplied: boolean;
  /** 사용 상태. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 표시 순서. */
  sortOrder: number;
}

export class CodeGroupListResponseDto {
  items: CodeGroupResponseDto[];
  /** 조건에 맞는 전체 건수. */
  total: number;
}

export class CodeItemResponseDto {
  /** 상세 코드. @example FULL */
  itemCode: string;
  /** 코드명. @example 정규직 */
  label: string;
  /** 사용 상태. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 표시 순서. */
  sortOrder: number;
}

export class CodeItemListResponseDto {
  items: CodeItemResponseDto[];
  /** 전체 건수. 상세 코드는 쪽을 나누지 않는다. */
  total: number;
}

export class BpApplicationResponseDto {
  /** 적용 대상 BP 수(사용 중인 고객 BP). */
  bpCount: number;
  /** 복사한 플랫폼 원본 상세 코드 수. 지운 것은 빠지고 사용 안 함은 포함된다. */
  itemCount: number;
  /** 실제로 넣은 행 수. BP 에 이미 있던 행은 건너뛰어 세지 않는다. */
  createdCount: number;
}
