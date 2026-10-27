import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  emptyToNull,
  INT4_MAX,
  LOGIN_ID_PATTERN,
  lowerEmail,
  NAME_PATTERN,
  PHONE_PATTERN,
  trimText,
} from '../platform-admin-format';
import { ADMIN_STATUSES, type AdminStatus } from './list-platform-admins.dto';

/** 등록 · 수정이 같이 받는 기본정보. 선택 칸은 비우면 NULL 로 저장한다. */
class PlatformAdminProfileDto {
  /** 이름. 한글 · 영문 2~20자. @example 이서준 */
  @Transform(trimText)
  @Matches(NAME_PATTERN, { message: '이름은 한글 또는 영문 2~20자입니다' })
  name: string;

  /** 연락처. 하이픈 없이 숫자 9~12자리. @example 01012345678 */
  @Matches(PHONE_PATTERN, { message: '연락처는 숫자 9~12자리입니다' })
  phone: string;

  /** 이메일. 소문자로 저장한다. 지우지 않은 사용 · 미사용 계정끼리 겹칠 수 없다. @example seojun@whale.test */
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다' })
  @MaxLength(100)
  email: string;

  /** 소속 부서. 선택, 30자까지. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(30)
  department?: string | null;

  /** 직책. 선택, 30자까지. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(30)
  jobTitle?: string | null;

  /** 우편번호. 선택 — 주소 검색 결과로 채운다. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다' })
  zipCode?: string | null;

  /** 기본주소. 선택 — 주소 검색 결과로 채운다. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  address?: string | null;

  /** 상세주소. 선택, 100자까지. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  addressDetail?: string | null;

  /** 사용자 권한 — 플랫폼 BP 의 PM · PA 권한 그룹 하나. 플랫폼 관리자는 PM 그룹을 줄 수 없다. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  roleGroupId: number;
}

/** 플랫폼 관리자 등록. 비밀번호 · 계정 상태는 받지 않는다 — 늘 사용으로 만들고 초기 비밀번호를 메일로 보낸다. */
export class CreatePlatformAdminDto extends PlatformAdminProfileDto {
  /** 아이디. 영문 또는 영문 · 숫자 4~20자. 삭제한 계정까지 포함해 겹칠 수 없고 바꿀 수 없다. @example seojun01 */
  @Transform(trimText)
  @Matches(LOGIN_ID_PATTERN, {
    message: '아이디는 영문 또는 영문 · 숫자 조합으로 4~20자입니다',
  })
  loginId: string;
}

/** 플랫폼 관리자 수정. 아이디는 바꾸지 않는다. 본인 계정은 권한 · 상태를 바꿀 수 없다. */
export class UpdatePlatformAdminDto extends PlatformAdminProfileDto {
  /** 계정 상태. 사용 · 미사용. 미사용이면 다음 요청부터 메뉴 권한을 보는 API 가 403 으로 막는다(이미 받은 토큰 · 세션은 그대로). */
  @IsIn(ADMIN_STATUSES)
  accountStatus: AdminStatus;

  /** 상세에서 받은 최종수정일시 그대로. 그 사이 다른 사람이 고쳤으면 저장하지 않고 409. */
  @IsISO8601({ strict: true })
  updatedAt: string;
}
