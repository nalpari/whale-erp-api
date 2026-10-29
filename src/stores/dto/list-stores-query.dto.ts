import { OmitType } from '@nestjs/swagger';
import { NO_NUL } from '../../common/no-nul';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  digitsOnly,
  STORE_PAGE_SIZES,
  type StorePageSize,
  STORE_STATUSES,
  STORE_TYPES,
  type StoreStatus,
  type StoreType,
} from '../store-format';

/** `a=1&a=2` 와 `a=1,2` 를 같은 배열로 받는다. */
const splitComma = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',') : value;

/** splitComma 에 숫자 변환까지. @Type 은 @Transform 보다 먼저 돌아 쉼표로 나눈 조각을 숫자로 바꾸지 못한다. */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = splitComma({ value });
  return Array.isArray(parts)
    ? parts.map((p: unknown) =>
        typeof p === 'string' && p !== '' ? Number(p) : p,
      )
    : parts;
};

/** 점포 정보 관리 목록 검색. 조건은 모두 AND. BP 는 쿼리가 아니라 X-Bp-Code-Id 헤더로 받는다(가드가 정한다). */
export class ListStoresQueryDto {
  /** 고른 점포. 여러 개는 `storeIds=1&storeIds=2` 또는 쉼표로, 1000개까지. 주지 않으면 볼 수 있는 점포 전체. */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /** 점포명 · 점포코드에 들어 있으면 나온다. 점포 다중 선택의 후보를 찾는 데 쓴다. @example 서초 */
  @IsOptional()
  @IsString()
  @Transform(trimText)
  @MaxLength(50)
  @Matches(NO_NUL, { message: '쓸 수 없는 문자가 있습니다.' })
  keyword?: string;

  /** 사업자등록번호. 하이픈을 빼고 숫자만 견주며, 일부만 넣어도 찾는다. @example 123-45 */
  @IsOptional()
  @IsString()
  @Transform(digitsOnly)
  @Matches(/^[0-9]{1,10}$/, {
    message: '사업자등록번호는 숫자 10자리 이내로 찾습니다.',
  })
  bizRegistrationNumber?: string;

  /** 점포 상태. 주지 않으면 미운영 · 운영(폐점은 고를 때만 나온다). */
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_STATUSES, { each: true })
  statuses?: StoreStatus[];

  /** 점포 유형. 주지 않으면 둘 다. */
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_TYPES, { each: true })
  storeTypes?: StoreType[];

  /** 쪽 번호. 1부터. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page: number = 1;

  /** 한 쪽 건수. 20 · 50 · 100, 기본 20. */
  @IsOptional()
  @Type(() => Number)
  @IsIn(STORE_PAGE_SIZES)
  pageSize: StorePageSize = 20;
}

/** 엑셀 바로 받기 — 목록과 같은 검색 조건, 쪽 나눔 없이 전부. */
export class StoreExcelQueryDto extends OmitType(ListStoresQueryDto, [
  'page',
  'pageSize',
] as const) {}

/** 변경 이력 쪽 이동. 한 쪽 10건이 기본이다. */
export class StoreHistoryPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 10;
}
