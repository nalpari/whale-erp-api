import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CODE_PATTERN } from '../../code-groups/code-format';
import { NO_NUL } from '../../common/no-nul';
import {
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  FACILITY_GROUPS,
  FACILITY_PAGE_SIZES,
  type FacilityGroup,
  type FacilityPageSize,
} from '../facility-format';

/** `a=1&a=2` 와 `a=1,2` 를 같은 숫자 배열로 받는다. */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = typeof value === 'string' ? value.split(',') : value;
  return Array.isArray(parts)
    ? parts.map((p: unknown) =>
        typeof p === 'string' && p !== '' ? Number(p) : p,
      )
    : parts;
};

/** 시설물·장비 목록 검색. 조건은 모두 AND. BP 는 X-Bp-Code-Id 헤더로 받는다(가드가 정한다). */
export class ListFacilitiesQueryDto {
  /** 고른 점포 — `storeIds=1&storeIds=2` 또는 쉼표, 1000개까지. 폐점 점포도 고를 수 있다. 주지 않으면 볼 수 있는 점포 전체 */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /** 운영상태 — 주지 않으면 전체 */
  @IsOptional()
  @IsString()
  @Matches(CODE_PATTERN)
  facilityStatusCode?: string;

  /** 그룹 — 주지 않으면 전체 */
  @IsOptional()
  @IsIn(FACILITY_GROUPS)
  facilityGroupCode?: FacilityGroup;

  /** 분류 — 그룹을 고른 경우에만(PL-3). 그룹 없이 보내면 400 */
  @IsOptional()
  @IsString()
  @Matches(CODE_PATTERN)
  facilityCategoryCode?: string;

  /** 시설물/장비명에 들어 있으면 나온다 @example 그라인더 */
  @IsOptional()
  @IsString()
  @Transform(trimText)
  @MaxLength(100)
  @Matches(NO_NUL, { message: '쓸 수 없는 문자가 있습니다.' })
  keyword?: string;

  /** 쪽 번호 — 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page: number = 1;

  /** 한 쪽 건수 — 50 · 100, 기본 50 */
  @IsOptional()
  @Type(() => Number)
  @IsIn(FACILITY_PAGE_SIZES)
  pageSize: FacilityPageSize = 50;
}

/** 점포 선택지 — 등록 화면은 폐점을 빼고, 목록 필터는 넣는다 */
export class FacilityStoreOptionsQueryDto {
  /** 폐점 점포도 넣는가 — 목록 필터는 true, 등록 화면은 false(기본) */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeClosed: boolean = false;
}

/** 관리 담당자 선택지 — 그 점포의 재직 직원 */
export class FacilityManagerOptionsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  storeId: number;
}
