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
import { trimText } from '../../platform-admins/platform-admin-format';

export const BP_STATUSES = ['ACTIVE', 'INACTIVE', 'WITHDRAWN'] as const;
export type BpStatus = (typeof BP_STATUSES)[number];

export const BP_SEARCH_TYPES = [
  'BP_CODE',
  'LOGIN_ID_NAME',
  'TRADE_NAME',
  'BIZ_REGISTRATION_NUMBER',
] as const;
export type BpSearchType = (typeof BP_SEARCH_TYPES)[number];

export const BP_VERIFICATIONS = ['VERIFIED', 'UNVERIFIED'] as const;
export type BpVerification = (typeof BP_VERIFICATIONS)[number];

/** 목록 한 쪽 건수 — 20 · 50 · 100(BP-1). */
export const BP_PAGE_SIZES = [20, 50, 100] as const;

/** BP 마스터 검색 조건. 엑셀도 같은 조건을 받는다. 조건은 모두 AND, 주지 않으면 전체. */
export class BpMasterFilterDto {
  /** 검색 기준. 검색어와 함께 준다 — 검색어만 주면 BP 코드 · 아이디 · 이름 · 상호명 · 사업자등록번호 어디든 맞으면 나온다. */
  @IsOptional()
  @IsIn(BP_SEARCH_TYPES)
  searchType?: BpSearchType;

  /** 검색어. 부분 일치, 대소문자 구분 없음. 탈퇴 BP 는 이름으로 찾히지 않는다. @example 한강 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(50)
  keyword?: string;

  /** BP 상태. 여러 개는 `statuses=ACTIVE&statuses=INACTIVE` 또는 쉼표로. 주지 않으면 셋 다. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsIn(BP_STATUSES, { each: true })
  statuses?: BpStatus[];

  /** 사업자정보 인증. 인증 = 최종 인증일시가 있다. 주지 않으면 전체. */
  @IsOptional()
  @IsIn(BP_VERIFICATIONS)
  verification?: BpVerification;
}

export class ListBpMastersDto extends BpMasterFilterDto {
  /** 쪽 번호. 1부터, 최대 10,000,000 — 건너뛸 행 수가 integer 범위를 넘지 않게. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page: number = 1;

  /** 한 쪽 건수. 20 · 50 · 100, 기본 20. */
  @IsOptional()
  @Type(() => Number)
  @IsIn(BP_PAGE_SIZES)
  pageSize: number = 20;
}
