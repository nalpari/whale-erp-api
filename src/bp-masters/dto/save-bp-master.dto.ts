import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
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
import { BpBusinessVerificationDto } from '../../auth/dto/bp-business-verification.dto';
import { HqLocationDto } from '../../stores/dto/hq-location.dto';
import {
  emptyToNull,
  INT4_MAX,
  LOGIN_ID_PATTERN,
  lowerEmail,
  NAME_PATTERN,
  PHONE_PATTERN,
  trimText,
} from '../../platform-admins/platform-admin-format';

/** 대표자 연락처 — 숫자 9~11자리(02 지역번호 포함). 마이페이지 사업자정보와 같다. */
const CEO_PHONE_PATTERN = /^[0-9]{9,11}$/;

/**
 * 등록 · 수정이 같이 받는 칸. 전체 치환이다 — 선택 칸을 빼고 보내면 그 칸은 비워진다. 예외는 HqLocationDto 에서 온
 * 본사 좌표 칸이다 — 위도 · 경도와 isLocationApplied 는 생략하면 그대로 둔다(좌표는 null 이어야 지운다). 사업자등록번호 · 대표자명 ·
 * 개업일자는 여기 적지 않는다 — 사업자 진위확인이 준 토큰(verificationToken)에서만 꺼낸다.
 */
class BpMasterProfileDto extends HqLocationDto {
  /** BP 마스터 이름. 한글 · 영문 2~20자. @example 김하늘 */
  @Transform(trimText)
  @Matches(NAME_PATTERN, { message: '이름은 한글 또는 영문 2~20자입니다.' })
  name: string;

  /** BP 마스터 연락처. 하이픈 없이 숫자 10~11자리. @example 01012345678 */
  @Matches(PHONE_PATTERN, { message: '연락처는 숫자 10~11자리입니다.' })
  phone: string;

  /** BP 마스터 이메일. 소문자로 저장한다. 지우지 않은 사용 · 미사용 관리자 계정끼리 겹칠 수 없다. @example ceo@hangang.co.kr */
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다.' })
  @MaxLength(100)
  email: string;

  /** 상호명. 1~50자. @example 한강상회 */
  @Transform(trimText)
  @Length(1, 50, { message: '상호명은 1~50자로 입력해 주세요.' })
  tradeName: string;

  /** 대표자 연락처. 숫자 9~11자리. 비워 둘 수 있다. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(CEO_PHONE_PATTERN, {
    message: '대표자 연락처는 숫자 9~11자리입니다.',
  })
  bizCeoPhone?: string | null;

  /** 대표자 이메일. 비워 둘 수 있다. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsEmail({}, { message: '대표자 이메일 형식이 아닙니다.' })
  @MaxLength(100)
  bizCeoEmail?: string | null;

  /** 사업장 우편번호 — 주소 검색 결과. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(10)
  bizZipCode?: string | null;

  /** 사업장 기본주소 — 주소 검색 결과. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  bizAddress?: string | null;

  /** 사업장 상세주소 — 직접 입력. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  bizAddressDetail?: string | null;

  /** 업태. 50자까지. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  bizCategory?: string | null;

  /** 종목. 50자까지. */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  bizItem?: string | null;

  /**
   * POST /bp-masters/business-verifications 가 준 10분짜리 토큰. 실으면 그 안의 사업자등록번호 · 대표자명 ·
   * 개업일자와 인증일시를 함께 저장한다. 비우면 그 세 값은 그대로 둔다(등록이면 미인증).
   */
  @IsOptional()
  @IsString()
  verificationToken?: string;
}

/** BP 등록 — BP 와 그 BP 마스터 계정을 함께 만든다. 비밀번호 · 상태는 받지 않는다(늘 사용, 초기 비밀번호는 메일로만). */
export class CreateBpMasterDto extends BpMasterProfileDto {
  /** BP 마스터 아이디. 영문 또는 영문 · 숫자 4~20자, 소문자로 저장한다. 삭제 · 탈퇴한 계정까지 겹칠 수 없다. @example hangang01 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(LOGIN_ID_PATTERN, {
    message: '아이디는 영문 또는 영문 · 숫자 조합으로 4~20자입니다.',
  })
  loginId: string;
}

/** BP 수정. 아이디 · BP 코드 · 가입경로 · 상태는 바꾸지 않는다. 동시 수정은 막지 않는다 — 마지막 저장이 남는다(S-CQGGZS). */
export class UpdateBpMasterDto extends BpMasterProfileDto {
  /** 본사의 사업자등록번호 · 대표자명 · 개업일자 · 인증일시를 전부 비운다 — 마이페이지 사업자정보의
   * clearBusinessVerification 과 같다(2026-11-18 사용자 요청). true 면 그 네 칸을 null 로 쓰고, 사업자번호가
   * 없어진 본사는 미운영으로 내려간다. 이미 비어 있으면 바뀌는 것 없이 성공한다. verificationToken 과 함께
   * 보내면 400(서비스에서 본다). 등록에는 두지 않는다. 구독 기록이 있으면 막아야 하지만(마이페이지와 같은
   * 사용자 결정) 구독 자체가 아직 없어 지금은 검사하지 않는다 — 구독이 생기면 마이페이지
   * (BpProfileUpdateDto)와 함께 여기에도 그 검사를 더한다. */
  @IsOptional()
  @IsBoolean()
  clearBusinessVerification?: boolean;
}

/** 사업자 진위확인. 수정 화면은 bpCodeId 를 보내 자기 BP 가 쓰는 번호를 중복으로 보지 않게 한다. */
export class VerifyBpMasterBusinessDto extends BpBusinessVerificationDto {
  /** 수정 중인 BP. 등록이면 비운다. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  bpCodeId?: number;
}
