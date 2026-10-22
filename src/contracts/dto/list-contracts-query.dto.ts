import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { INT4_MAX } from '../../platform-admins/platform-admin-format';
import { STORE_TYPES, type StoreType } from '../../stores/store-format';

/** `a=1&a=2` · `a=1,2` · 둘을 섞은 `a=1,2&a=3` 을 모두 같은 배열로 받는다. */
const splitComma = ({ value }: { value: unknown }): unknown =>
  (Array.isArray(value) ? value : [value]).flatMap((v: unknown) =>
    typeof v === 'string' ? v.split(',') : [v],
  );

/** splitComma 에 숫자 변환까지. 숫자만 받는다 — `0x10` · `1e3` · 빈 조각은 NaN 으로 두어 검증이 막는다(400). */
const splitNumbers = ({ value }: { value: unknown }): unknown =>
  (splitComma({ value }) as unknown[]).map((p) =>
    typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : NaN,
  );

export class ListContractsQueryDto {
  /** 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;

  /** 여러 개면 `?status=SIGNED&status=REJECTED`. 없으면 전체 */
  @ApiPropertyOptional({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    isArray: true,
  })
  @IsOptional()
  // 하나만 오면 쿼리 파서가 배열이 아니라 문자열로 준다.
  @Transform(({ value }: { value: unknown }): unknown[] =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsEnum(ContractStatus, { each: true })
  status?: ContractStatus[];

  /**
   * 고른 점포(관리자웹 목록 점포 필터 · 상단 점포 범위, WHALEERP-133 · 326). 쉼표로 1000개까지(`storeIds=1,2`). 같은 키
   * 반복(`storeIds=1&storeIds=2`)도 받지만 쿼리 파서가 키를 1000개까지만 읽어 넘치면 뒤 조건이 400 없이 빠지므로 많을 때는
   * 쉼표로 보낸다(api #132 리뷰). 업무 범위 밖의 id 는 조용히 빠진다. 주지 않으면 업무 범위 전체.
   */
  @ApiPropertyOptional({ type: [Number], example: [3, 5] })
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];

  /** 점포 유형(직영 · 가맹) — 상단 점포 범위의 직영 · 가맹. 주지 않으면 둘 다. */
  @ApiPropertyOptional({ enum: STORE_TYPES, isArray: true })
  @IsOptional()
  @Transform(splitComma)
  @IsIn(STORE_TYPES, { each: true })
  storeTypes?: StoreType[];

  /** 점포 이름 일부 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  storeName?: string;

  /** 직원 이름 일부 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  staffMemberName?: string;
}
