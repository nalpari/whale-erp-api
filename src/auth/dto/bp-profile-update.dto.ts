import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { trimText } from '../../platform-admins/platform-admin-format';

const PHONE_PATTERN = /^[0-9]{9,11}$/;

/**
 * 내 BP 사업자정보 수정(S-UOJVUR). 사업자등록번호 · 대표자명 · 개업일자는 포함하지 않는다 — 그 셋은
 * 사업자 번호 인증(재인증)으로만 바뀐다(BpBusinessVerificationDto). 인증 여부와 관계없이 바로 고칠 수
 * 있는 항목만 받는다.
 */
export class BpProfileUpdateDto {
  /** 상호명. 1~50자. @example 한강상회 */
  @Transform(trimText)
  @Length(1, 50, { message: '상호명은 1~50자로 입력해 주세요.' })
  tradeName: string;

  /** 대표자 연락처. 하이픈 없이 숫자 9~11자리(02 지역번호 포함). 비워 둘 수 있다. @example 01012345678 */
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: '대표자 연락처는 숫자 9~11자리입니다' })
  bizCeoPhone?: string;

  /** 대표자 이메일. 비워 둘 수 있다. @example ceo@hangang.co.kr */
  @IsOptional()
  @Transform(trimText)
  @IsEmail({}, { message: '대표자 이메일 형식이 아닙니다' })
  @MaxLength(100)
  bizCeoEmail?: string;

  /** 사업장 우편번호 — 주소 검색 컴포넌트가 고른 값만. @example 04524 */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  bizZipCode?: string;

  /** 사업장 기본주소 — 주소 검색 컴포넌트가 고른 값만. @example 서울특별시 중구 세종대로 110 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bizAddress?: string;

  /** 사업장 상세주소 — 직접 입력. @example 3층 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(100)
  bizAddressDetail?: string;

  /** 업태. 비워 둘 수 있다. @example 도소매업 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(50)
  bizCategory?: string;

  /** 종목. 비워 둘 수 있다. @example 제과점 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(50)
  bizItem?: string;

  /** 내 사업자정보 조회 응답의 updatedAt 그대로. 그사이 재인증 등으로 바뀌었으면 409. */
  @IsUpdatedAt()
  updatedAt: string;
}
