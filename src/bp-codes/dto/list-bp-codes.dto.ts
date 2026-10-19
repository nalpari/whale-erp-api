import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** BP 선택 목록 검색. 목록 응답 규칙의 page(1부터) · pageSize(기본 20, 최대 200). */
export class ListBpCodesDto {
  /** 상호 · BP코드 중 하나에 들어 있으면 나온다(대소문자 무시). 앞뒤 공백은 자른다. @example 고래 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  keyword?: string;

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
