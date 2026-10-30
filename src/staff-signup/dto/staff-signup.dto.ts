import { ApiProperty } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { IsSendableEmail } from '../../mail/is-sendable-email';
import { MAX_EMAIL_LENGTH } from '../../mail/mail-address';
import { LoginResponseDto } from '../../auth/dto/login.response.dto';
import { IsHqSharingConsentVersion } from '../hq-sharing-consent';
import { InvitationLookupDto } from './invitation-lookup.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * 직원 앱 가입(WHALEERP-601 · 142, 진입 · 가입 화면 가이드 ③). 초대를 찾는 값(토큰 또는 휴대전화번호 + 초대 코드)과 계정 ·
 * 인적사항을 함께 받는다. 본인인증은 없다(2026-10-16) — 이름 · 생년월일 · 성별 · 외국인 여부는 날인 때 근로계약서 값과
 * 대조한다(WHALEERP-125 「본인 대조」). **계정의 휴대전화번호는 받지 않고 초대(근로계약서)의 번호를 쓴다**(JOIN-7 — 고칠 수
 * 있으면 남의 번호로 가입해 그 사람의 다음 초대를 막을 수 있다). 이름 규칙은 근로계약서 직원 정보와 같다. 약관 동의는
 * 1팀 공통 약관 등록이 생기면 더한다(2026-10-20 김민식).
 */
export class StaffSignupDto extends InvitationLookupDto {
  /** 로그인 아이디. 소문자로 맞춰 저장한다(accounts_email_lower). 핀으로 확인하지 않는다 */
  @Transform(trimLower)
  @IsEmail({}, { message: '이메일 형식으로 입력해 주세요.' })
  // 비밀번호 찾기 핀 · 재설정 링크가 이 주소로 메일로 간다. @IsEmail 은 따옴표 로컬 파트(`"a"@example.com`)를 받지만
  // 메일 발송은 막아 스스로 복구할 수 없게 되므로 같이 건다(api #81 3차 리뷰, 이메일 변경 핀 요청과 같다)
  @IsSendableEmail({ message: '메일을 보낼 수 없는 형식의 이메일입니다.' })
  @MaxLength(MAX_EMAIL_LENGTH)
  email: string;

  /** 영문 대문자 · 소문자 · 숫자 · 특수문자 중 3가지 이상이면 8자, 2가지면 10자 이상, 20자까지 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  /** YYYY-MM-DD. 가입하는 날(한국 시간) 만 19세 미만이면 가입하지 않는다(운영 정책 ACC-22). 가입한 뒤 고칠 수 없다 */
  @IsDateOnly('생년월일은 YYYY-MM-DD 형식의 날짜입니다.')
  birthDate: string;

  /**
   * 성별 — 남 · 여. 필수다 — 날인 때 근로계약서 값과 본인 대조하므로 빈 계정을 만들지 않는다(가입 화면도 필수,
   * 운영 정책 ACC-23 · JOI-10, 2026-10-21 재영)
   */
  // enumName 을 주면 근로계약서의 Gender 스키마와 설명을 나눠 써 한쪽 설명이 덮인다 — 여기서는 펼쳐 둔다
  @ApiProperty({ enum: Gender })
  @IsEnum(Gender, { message: '성별을 골라 주세요.' })
  gender: Gender;

  /** 외국인 여부 — 체크하지 않으면 내국인(false) */
  @IsOptional()
  @IsBoolean()
  isForeigner?: boolean;

  /** 우편번호 5자리 — 주소 검색 API 값(ACC-20) */
  @Matches(/^[0-9]{5}$/, { message: '우편번호는 숫자 5자리입니다.' })
  zipCode: string;

  /** 기본주소(도로명) — 주소 검색 API 값 */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  address: string;

  /** 상세주소 — 직접 입력 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  addressDetail?: string;

  /**
   * 본사 제공 동의(운영 정책 ATT-30, 선택). 초대 확인의 asksHqSharingConsent 가 true 일 때만 쓴다 — 직영 점포면 보내도
   * 저장하지 않는다. 동의는 계정에 하나다(api #78). 동의하지 않아도 가입과 근무는 그대로다
   */
  @IsOptional()
  @IsBoolean()
  hqSharingConsented?: boolean;

  /**
   * 본사 제공 동의 문구 버전 — 화면이 보인 문구의 버전(예: v1.0, ATT-30 v252). hqSharingConsented 가 true 일 때
   * 싣는다(실었으면 비지 않은 64자 이하 문자열 — 아니면 400), 아니면 보지 않는다. 빠지거나 지금 버전과 다르면 가입은 그대로
   * 마치고 동의만 남기지 않는다 — 응답의 hqSharingConsentRecorded 가 false 다(예전 앱 · 배포 어긋남에도 막지 않는다, v253)
   */
  @IsHqSharingConsentVersion()
  hqSharingConsentVersion?: string;

  /** 이 기기 — 로그인과 같다. 같은 기기의 앞 접속을 끝낸다 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  deviceIdentifier?: string;
}

/** 가입 응답 — 로그인 응답에 본사 제공 동의를 남겼는지를 더한다 */
export class StaffSignupResponseDto extends LoginResponseDto {
  /**
   * 본사 제공 동의를 남겼는지(ATT-30 v253). true 남김 · false 동의했지만 보인 문구 버전이 지금과 달라 남기지 않음(가입은
   * 마쳤다 — 앱은 내 정보에서 다시 동의하라고 알린다) · null 남길 동의가 없음(직영 점포 · 동의하지 않음)
   */
  @ApiProperty({ nullable: true, type: Boolean })
  hqSharingConsentRecorded: boolean | null;
}
