import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { NO_NUL } from '../../common/no-nul';
import { CODE_PATTERN } from '../../code-groups/code-format';
import { IsUpdatedAt } from '../../common/updated-at';
import {
  emptyToNull,
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  FACILITY_GROUPS,
  type FacilityGroup,
  QUANTITY_MAX,
  UNIT_PRICE_MAX,
} from '../facility-format';

const NUL_MESSAGE = '쓸 수 없는 문자가 있습니다.';

/** 전화번호는 세 칸을 이어 숫자만 받는다 — 하이픈 · 공백은 떼고, 비면 null(지운다). */
const phoneDigits = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const digits = value.replace(/[-\s]/g, '');
  return digits === '' ? null : digits;
};

/** 메모는 공백 · 줄바꿈을 포함해 센다 — 앞뒤 공백을 지우지 않는다. 비었거나 공백뿐이면 null. */
const blankToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/** 기본값이 있는 칸의 검사 조건 — 빼고 보내면 기본값, null 은 검사해 400(@IsOptional 은 null 도 건너뛴다). */
const notOmitted = (_: object, value: unknown) => value !== undefined;
const present = (_: object, value: unknown) => value !== null;

/** 선택 글자 칸 하나의 데코레이터 묶음 — 앞뒤 공백을 지우고 비면 null. */
function OptionalText(max: number): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Transform(emptyToNull)(target, key);
    ValidateIf(present)(target, key);
    IsString()(target, key);
    MaxLength(max)(target, key);
    Matches(NO_NUL, { message: NUL_MESSAGE })(target, key);
  };
}

function OptionalPhone(label: string): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Transform(phoneDigits)(target, key);
    ValidateIf(present)(target, key);
    Matches(/^[0-9]{9,12}$/, {
      message: `${label} 전화번호는 숫자 9~12자리입니다.`,
    })(target, key);
  };
}

function OptionalDate(label: string): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Transform(emptyToNull)(target, key);
    ValidateIf(present)(target, key);
    IsDateOnly(`${label}은 YYYY-MM-DD 입니다.`)(target, key);
  };
}

/**
 * 등록 · 수정이 같이 쓰는 칸. 수정은 화면 전체를 다시 보낸다 — 빠지거나 빈 선택 칸은 지운다(관리 정보는 따로 지우지
 * 않고 칸을 비워 저장한다, 정책서 PL-4). 공통코드 값(운영상태 · 분류 · 점검 주기)이 있는지와 날짜 앞뒤, 관리 담당자는
 * 서비스가 본다.
 */
export class SaveFacilityDto {
  /** 시설물/장비명 — 1~100자 */
  @IsString()
  @Transform(trimText)
  @Length(1, 100)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  name: string;

  /** 운영상태 — 공통코드 FACILITY_STATUS(운영 OPERATING · 보관 STORED · 폐기 DISPOSED). 화면 처음 값은 운영 */
  @IsString()
  @Matches(CODE_PATTERN, { message: '운영상태를 선택해 주세요.' })
  facilityStatusCode: string;

  /** 그룹 — STORE_FACILITY(점포 시설물) · STORE_EQUIPMENT(점포 장비) */
  @IsIn(FACILITY_GROUPS, { message: '그룹을 선택해 주세요.' })
  facilityGroupCode: FacilityGroup;

  /** 분류 — 고른 그룹의 상세 코드(점포 BP 의 사용 중인 코드. 수정은 지금 값이면 미사용도 그대로 둘 수 있다) */
  @IsString()
  @Matches(CODE_PATTERN, { message: '분류를 선택해 주세요.' })
  facilityCategoryCode: string;

  /** 메모 — 공백 · 줄바꿈을 포함해 200자 */
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf(present)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  memo?: string | null;

  /** 브랜드 — 100자 */
  @OptionalText(100)
  brand?: string | null;

  /** 제조사 — 100자 */
  @OptionalText(100)
  manufacturer?: string | null;

  /** Serial number — 100자 */
  @OptionalText(100)
  serialNumber?: string | null;

  /** 설치 위치 — 100자 */
  @OptionalText(100)
  installationLocation?: string | null;

  /** 구매처 — 100자 */
  @OptionalText(100)
  vendorName?: string | null;

  /** 구매처 전화번호 — 숫자 9~12자리. 하이픈은 떼고 받는다 @example 0212345678 */
  @OptionalPhone('구매처')
  vendorPhone?: string | null;

  /** 영업사원 — 50자 */
  @OptionalText(50)
  salesRepresentativeName?: string | null;

  /** 영업사원 전화번호 — 숫자 9~12자리 */
  @OptionalPhone('영업사원')
  salesRepresentativePhone?: string | null;

  /** 단가 — 원, 0 이상 정수 10자리까지. 총금액(단가 × 수량)은 서버가 계산한다 */
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(UNIT_PRICE_MAX)
  unitPriceAmount?: number | null;

  /** 수량 — 1~9,999, 기본 1 */
  @ValidateIf(notOmitted)
  @IsInt()
  @Min(1)
  @Max(QUANTITY_MAX)
  quantity: number = 1;

  /** 부가세 포함 — 단가 · 총금액을 부가세 포함 금액으로 보는가. 기본 포함 */
  @ValidateIf(notOmitted)
  @IsBoolean()
  isVatIncluded: boolean = true;

  /** 구매일 @example 2025-01-01 */
  @OptionalDate('구매일')
  purchaseDate?: string | null;

  /** 설치일 — 구매일보다 앞설 수 없다 @example 2025-01-03 */
  @OptionalDate('설치일')
  installationDate?: string | null;

  /** 사용 유효기한 */
  @OptionalDate('사용 유효기한')
  usageExpiryDate?: string | null;

  /** 품질 보증기한 */
  @OptionalDate('품질 보증기한')
  warrantyExpiryDate?: string | null;

  /** 관리 담당자 — 점포의 재직 직원(staffMemberId). 선택지는 `GET /facilities/manager-options` */
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  managerStaffMemberId?: number | null;

  /** 관리 담당자 전화번호 — 숫자 9~12자리. 화면이 담당자 휴대폰으로 채우고 고칠 수 있다. 담당자를 고르지 않아도 따로 저장할 수 있다(2026-11-11 사용자 결정) */
  @OptionalPhone('관리 담당자')
  managerPhone?: string | null;

  /** 점검 주기 — 공통코드 INSPECTION_CYCLE(매일 DAILY · 매주 WEEKLY · 매월 MONTHLY · 수시 AS_NEEDED + BP 가 더한 값) */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf(present)
  @IsString()
  @Matches(CODE_PATTERN, { message: '점검 주기를 다시 선택해 주세요.' })
  inspectionCycleCode?: string | null;

  /** 점검 비고 — 200자 */
  @OptionalText(200)
  inspectionNote?: string | null;

  /** A/S센터 우편번호 — 숫자 5자리, 주소 검색 결과 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf(present)
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다.' })
  serviceCenterZipCode?: string | null;

  /** A/S센터 기본주소(도로명) — 주소 검색 결과, 200자 */
  @OptionalText(200)
  serviceCenterAddress?: string | null;

  /** A/S센터 상세주소 — 100자 */
  @OptionalText(100)
  serviceCenterAddressDetail?: string | null;

  /** A/S센터 전화번호 — 숫자 9~12자리 */
  @OptionalPhone('A/S센터')
  serviceCenterPhone?: string | null;
}

export class CreateFacilityDto extends SaveFacilityDto {
  /** 점포 — 내 관리 점포 범위 안, 폐점 아님. 등록 뒤 바꿀 수 없다(PL-1). 선택지는 `GET /facilities/store-options` */
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  storeId: number;
}

export class UpdateFacilityDto extends SaveFacilityDto {
  /** 상세에서 받은 updatedAt 그대로 — 그 사이 누가 고쳤으면 409 */
  @IsUpdatedAt()
  updatedAt: string;
}
