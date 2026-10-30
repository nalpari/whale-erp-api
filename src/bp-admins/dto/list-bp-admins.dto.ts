import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ADMIN_STATUSES,
  type AdminStatus,
  PageDto,
} from '../../platform-admins/dto/list-platform-admins.dto';
import {
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import { BP_ADMIN_ROLES, type BpAdminRole } from '../bp-admin-rules';

export const STORE_TYPES = ['DIRECT', 'FRANCHISE'] as const;
export type StoreType = (typeof STORE_TYPES)[number];

/**
 * `a=1&a=2` 와 `a=1,2` 를 같은 숫자 배열로 받는다. @Type 은 @Transform 보다 먼저 돌아 쓰지 않는다.
 * 빈 조각은 버린다 — `?storeIds=` 는 「점포 없음」이지 형식 오류가 아니다.
 */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = typeof value === 'string' ? value.split(',') : value;
  return Array.isArray(parts)
    ? parts
        .filter((p: unknown) => p !== '')
        .map((p: unknown) => (typeof p === 'string' ? Number(p) : p))
    : parts;
};

/** `a=x&a=y` · `a=x,y` · 둘을 섞은 것을 같은 글자 배열로 받는다. 빈 조각은 버린다. */
const splitTexts = ({ value }: { value: unknown }): unknown => {
  const parts = typeof value === 'string' ? [value] : value;
  return Array.isArray(parts)
    ? parts
        .flatMap((p: unknown) => (typeof p === 'string' ? p.split(',') : [p]))
        .filter((p: unknown) => p !== '')
    : parts;
};

/** BP 관리자 목록 검색. 조건은 모두 AND. BP 는 쿼리가 아니라 X-Bp-Code-Id 헤더로 받는다(가드가 정한다). */
export class ListBpAdminsDto extends PageDto {
  /** 아이디 · 이름 중 하나에 들어 있으면 나온다. @example 지수 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(20)
  keyword?: string;

  /** 이 점포를 관리하는 계정 — 매핑된 계정과 전체 점포 계정. 여러 개는 반복 또는 쉼표로, 1000개까지. */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /** 이 유형의 점포를 관리하는 계정 — 헤더의 직영 · 가맹 전체 범위용. 전체 점포 계정은 늘 나온다. */
  @IsOptional()
  @ApiProperty({ enum: STORE_TYPES, enumName: 'StoreType', required: false })
  @IsIn(STORE_TYPES)
  storeTypeCode?: StoreType;

  /** 권한 그룹. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  roleGroupId?: number;

  /**
   * 역할 — 고른 역할의 계정만. 여러 개는 반복 또는 쉼표로. 주지 않거나 비우면 세 역할 모두
   * (역할을 하나도 고르지 않은 화면은 api 를 부르지 않는다). @example FM,FA
   */
  @IsOptional()
  @Transform(splitTexts)
  @ApiProperty({
    enum: BP_ADMIN_ROLES,
    enumName: 'BpAdminRole',
    isArray: true,
    required: false,
  })
  @ArrayMaxSize(BP_ADMIN_ROLES.length)
  @IsIn(BP_ADMIN_ROLES, { each: true })
  roleTypeCodes?: BpAdminRole[];

  /** 계정 상태. 주지 않으면 사용 · 미사용 둘 다. */
  @IsOptional()
  @ApiProperty({
    enum: ADMIN_STATUSES,
    enumName: 'AdminAccountStatus',
    required: false,
  })
  @IsIn(ADMIN_STATUSES)
  accountStatus?: AdminStatus;
}

/** 권한 그룹 선택지를 물을 역할. */
export class BpAdminRoleQueryDto {
  /** 이 역할의 그룹만. 주지 않으면 세 역할 모두. */
  @IsOptional()
  @ApiProperty({
    enum: BP_ADMIN_ROLES,
    enumName: 'BpAdminRole',
    required: false,
  })
  @IsIn(BP_ADMIN_ROLES)
  roleTypeCode?: BpAdminRole;
}

/** 점포 선택지. 역할은 필수다 — 가맹 마스터와 가맹 관리자는 고를 수 있는 점포가 다르다. */
export class BpAdminStoreOptionsQueryDto {
  /** 등록 · 수정하는 계정의 역할. */
  @ApiProperty({ enum: BP_ADMIN_ROLES, enumName: 'BpAdminRole' })
  @IsIn(BP_ADMIN_ROLES)
  roleTypeCode: BpAdminRole;

  /** 수정 중인 가맹 마스터. 주면 그 계정이 맡은 점포를 「다른 가맹 마스터 담당」으로 빼지 않는다. 가맹 마스터가 아니면 쓰지 않는다. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  adminAccountId?: number;
}

/** 가맹 마스터를 저장하기 전 확인창용 — 저장하려는 상태와 점포. */
export class BpAdminUpdateImpactQueryDto {
  @ApiProperty({ enum: ADMIN_STATUSES, enumName: 'AdminAccountStatus' })
  @IsIn(ADMIN_STATUSES)
  accountStatus: AdminStatus;

  /** 저장하려는 점포. 반복 또는 쉼표로, 1000개까지. 비우면 점포를 모두 빼는 것으로 본다. */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds: number[] = [];
}
