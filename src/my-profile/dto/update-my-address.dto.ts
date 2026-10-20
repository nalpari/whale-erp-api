import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** 주소 수정 (WHALEERP-189). 우편번호 · 도로명 주소는 외부 주소 검색 값이고(ME-2), 상세 주소만 직원이 쓴다 */
export class UpdateMyAddressDto {
  /** 우편번호 — 도로명 주소 체계의 5자리 */
  @Transform(trimmed)
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다' })
  zipCode: string;

  /** 도로명 주소 — 주소 검색에서 고른 값 */
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address: string;

  /** 상세 주소. 비우거나 빼면 null 로 저장한다 — 주소 세 칸을 통째로 바꾼다 */
  @Transform(({ value }: { value: unknown }) => {
    const v = trimmed({ value });
    return v === '' ? null : v;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressDetail?: string | null;
}
