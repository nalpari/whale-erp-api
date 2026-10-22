import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NO_NUL } from '../../common/no-nul';
import { IsDateOnly } from '../../common/is-date-only';
import { IsUpdatedAt } from '../../common/updated-at';
import {
  emptyToNull,
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  digitsOnly,
  FLOOR_TYPES,
  type FloorType,
  STORE_STATUSES,
  STORE_TYPES,
  type StoreStatus,
  type StoreType,
} from '../store-format';

const NUL_MESSAGE = '쓸 수 없는 문자가 있습니다';

/** 층별 정보 한 줄. 모든 칸이 선택이다. */
export class StoreFloorInputDto {
  /** 지상 · 지하 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(FLOOR_TYPES)
  floorTypeCode?: FloorType | null;

  /** 층수 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(999)
  floorNumber?: number | null;

  /** 매장평수 — 소수 1자리 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(9_999_999.9)
  floorAreaPyeong?: number | null;

  /** 전용면적(㎡) — 소수 2자리 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999.99)
  floorAreaSqm?: number | null;

  /** 좌석수 — 0 이상 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  seatCount?: number | null;
}

/** 인증과 상관없이 직접 넣는 사업자정보. 빈 값은 지운다. */
export class StoreBusinessInputDto {
  /** 상호명 — 국세청이 돌려주지 않아 직접 넣는다. 50자. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  tradeName?: string | null;

  /** 대표자 연락처 — 숫자 10~11자리 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[0-9]{10,11}$/, {
    message: '대표자 연락처는 숫자 10~11자리입니다',
  })
  ceoPhone?: string | null;

  /** 사업자 우편번호 — 숫자 5자리 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다' })
  zipCode?: string | null;

  /** 사업자 기본주소 — 주소 검색 결과 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  address?: string | null;

  /** 사업자 상세주소 — 100자 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  addressDetail?: string | null;

  /** 업태 — 50자 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  category?: string | null;

  /** 종목 — 50자 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  item?: string | null;
}

/** 사업자 진위확인에 넣는 세 값. 저장할 때 서버가 국세청에 다시 확인한다 — 화면의 결과를 믿지 않는다. */
export class BusinessIdentityInputDto {
  /** 사업자등록번호 — 하이픈은 빼고 숫자 10자리로 저장한다. @example 123-45-67890 */
  @IsString()
  @Transform(digitsOnly)
  @Matches(/^[0-9]{10}$/, { message: '사업자등록번호는 숫자 10자리입니다' })
  bizRegistrationNumber: string;

  /** 대표자명 */
  @IsString()
  @Transform(trimText)
  @Length(1, 50)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  ceoName: string;

  /** 개업일자. @example 2020-03-02 */
  @IsDateOnly('개업일자는 YYYY-MM-DD 입니다')
  openDate: string;
}

/**
 * 기본값이 있는 칸의 검사 조건. 빼고 보내면 기본값이고, null 은 검사해 400 이다 — @IsOptional 은 null 도
 * 건너뛰는데, null 은 기본값을 덮어쓴다.
 */
const notOmitted = (_: object, value: unknown) => value !== undefined;

/** 등록 · 수정이 같이 쓰는 칸. 수정은 화면 전체를 다시 보낸다(빠진 선택 칸은 지운다 — 인증한
 * 사업자등록번호 · 대표자명 · 개업일자만은 인증으로만 바뀐다). */
export class SaveStoreDto {
  /** 점포명 — 1~50자 */
  @IsString()
  @Transform(trimText)
  @Length(1, 50)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  name: string;

  /** 점포 연락처 — 숫자 9~11자리 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[0-9]{9,11}$/, { message: '점포 연락처는 숫자 9~11자리입니다' })
  phone?: string | null;

  /** 우편번호 — 숫자 5자리, 주소 검색 결과 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다' })
  zipCode?: string | null;

  /** 기본주소 — 주소 검색 결과 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  address?: string | null;

  /** 상세주소 — 100자 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  @Matches(NO_NUL, { message: NUL_MESSAGE })
  addressDetail?: string | null;

  /** 위도 — −90~90, 소수 6자리 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  /** 경도 — −180~180, 소수 6자리 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  /** 위치 적용 여부 — 기본 사용. 3팀 출퇴근 위치 확인이 볼 자리다(아직 읽는 곳은 없다). */
  @ValidateIf(notOmitted)
  @IsBoolean()
  isLocationApplied: boolean = true;

  /** 층별 정보. 저장할 때마다 이 목록으로 바꾼다. 모든 칸이 빈 줄은 버린다. */
  @ValidateIf(notOmitted)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => StoreFloorInputDto)
  floors: StoreFloorInputDto[] = [];

  /** 직접 넣는 사업자정보 */
  @ValidateIf(notOmitted)
  @IsObject()
  @ValidateNested()
  @Type(() => StoreBusinessInputDto)
  business: StoreBusinessInputDto = new StoreBusinessInputDto();

  /**
   * 사업자 인증. 인증한 화면에서만 보낸다 — 서버가 다시 확인하고 맞으면 사업자등록번호 · 대표자명 · 개업일자를
   * 저장한다. 이미 번호가 있는 점포는 재인증이라 번호 · 개업일자가 저장된 값과 같아야 한다.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => BusinessIdentityInputDto)
  businessVerification?: BusinessIdentityInputDto;
}

export class CreateStoreDto extends SaveStoreDto {
  /** 점포 유형 — 등록 뒤 바꾸지 않는다 */
  @IsIn(STORE_TYPES)
  storeTypeCode: StoreType;

  /**
   * 소속 BP — 보내지 않는다. BP 는 X-Bp-Code-Id 헤더(가드)로 정해지고, 이 칸은 헤더와 같을 때만 받는다(다르면 400).
   * front 가 아직 보내서 남겨 둔 칸이다 — front 가 보내지 않게 되면 뺀다.
   * @deprecated
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  bpCodeId?: number;
}

export class UpdateStoreDto extends SaveStoreDto {
  /** 점포 상태. 미운영 → 운영 · 폐점, 운영 → 폐점만. 그대로 두려면 지금 값을 보낸다. */
  @IsIn(STORE_STATUSES)
  storeStatus: StoreStatus;

  /** 상세에서 받은 updatedAt 그대로 — 그 사이 누가 고쳤으면 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 저장 전 인증 확인. 수정 화면이면 그 점포를 빼고 번호 중복을 본다. */
export class VerifyStoreBusinessDto extends BusinessIdentityInputDto {
  /** 수정 중인 점포. 등록 화면이면 보내지 않는다. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  storeId?: number;
}
