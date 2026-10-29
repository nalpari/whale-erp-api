import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { INT4_MAX, trimText } from '../platform-admin-format';

export const ADMIN_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export const ROLE_GROUP_PURPOSES = ['filter'] as const;
export type RoleGroupPurpose = (typeof ROLE_GROUP_PURPOSES)[number];

/** GET /platform-admins/role-groups 의 쿼리. */
export class PlatformRoleGroupsQueryDto {
  /** `filter` 면 목록 필터용 — 호출자와 상관없이 플랫폼 권한(PM · PA) 그룹을 다 준다. 없으면 등록 · 수정 선택지. */
  @IsOptional()
  @IsIn(ROLE_GROUP_PURPOSES)
  purpose?: RoleGroupPurpose;
}

/** 한 쪽 이동. 목록 응답 규칙의 page(1부터) · pageSize(기본 20, 최대 200). */
export class PageDto {
  /** 쪽 번호. 1부터, 최대 10,000,000 — 건너뛸 행 수가 integer 범위를 넘지 않게. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page: number = 1;

  /** 한 쪽 건수. 기본 20, 최대 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;
}

/** 플랫폼 관리자 목록 검색. 조건은 모두 AND, 주지 않으면 전체. */
export class ListPlatformAdminsDto extends PageDto {
  /** 아이디 · 이름 중 하나에 들어 있으면 나온다. @example 서준 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(20)
  keyword?: string;

  /** 사용자 권한(권한 그룹). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  roleGroupId?: number;

  /** 계정 상태. 여러 개는 `statuses=ACTIVE&statuses=INACTIVE` 또는 쉼표로. 주지 않으면 둘 다. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsIn(ADMIN_STATUSES, { each: true })
  statuses?: AdminStatus[];
}
