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
import {
  emptyToNull,
  trimText,
} from '../../platform-admins/platform-admin-format';

const PHONE_PATTERN = /^[0-9]{9,11}$/;

/**
 * 내 BP 사업자정보 수정(S-UOJVUR). 사업자등록번호 · 대표자명 · 개업일자는 여기 직접 적지 않는다 — 점포
 * 사업자정보와 같은 패턴(2026-10-22 사용자 결정)으로, 먼저 POST /me/bp/business-verification 으로
 * 검사만 하고 받은 토큰(businessVerificationToken)을 실어야 그 세 값이 저장된다. 토큰 없이 보내면
 * 인증 쪽 세 값은 그대로 둔다 — 상호명 · 대표자 연락처 · 대표자 이메일 · 사업장주소 · 업태 · 종목만 받는다.
 *
 * 선택 칸은 전부 emptyToNull 을 먼저 거친다 — 비워서 보내면 null 로 저장되고, 조회(GET)가 미인증 값을
 * 빈 문자열로 돌려주는 모양과 맞아야 그 값을 그대로 다시 보내는 저장도 형식 검사(전화번호 · 이메일)에
 * 걸리지 않는다(코드 리뷰로 찾음, 2026-10-22 — 빈 문자열은 @IsOptional 이 건너뛰지 않는다).
 *
 * 이 PATCH 는 부분 수정이 아니라 전체 치환이다 — 선택 칸을 아예 빼고 보내면(부분 PATCH 를 기대하고
 * "이 칸은 그대로 두겠다"는 뜻으로) 그 칸도 null 로 지워진다. 화면(bp-profile-tab.tsx)은 조회로 받은
 * 값을 그대로 form 에 채워 두고 저장마다 전체를 다시 보내 이 문제를 피한다 — 새 호출자를 추가할 때는
 * 반드시 모든 선택 칸을 함께 보내야 한다(코드 리뷰로 찾음, 2026-10-22 — class-validator 의 @IsOptional
 * 은 "칸이 없어도 된다"는 뜻이라 "안 바뀐다"로 오해하기 쉽다).
 */
export class BpProfileUpdateDto {
  /** 상호명. 1~50자. @example 한강상회 */
  @Transform(trimText)
  @Length(1, 50, { message: '상호명은 1~50자로 입력해 주세요.' })
  tradeName: string;

  /** 대표자 연락처. 하이픈 없이 숫자 9~11자리(02 지역번호 포함). 비워 둘 수 있다. @example 01012345678 */
  @Transform(emptyToNull)
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: '대표자 연락처는 숫자 9~11자리입니다' })
  bizCeoPhone?: string;

  /** 대표자 이메일. 비워 둘 수 있다. @example ceo@hangang.co.kr */
  @Transform(emptyToNull)
  @IsOptional()
  @IsEmail({}, { message: '대표자 이메일 형식이 아닙니다' })
  @MaxLength(100)
  bizCeoEmail?: string;

  /** 사업장 우편번호 — 주소 검색 컴포넌트가 고른 값만. @example 04524 */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(10)
  bizZipCode?: string;

  /** 사업장 기본주소 — 주소 검색 컴포넌트가 고른 값만. @example 서울특별시 중구 세종대로 110 */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bizAddress?: string;

  /** 사업장 상세주소 — 직접 입력. @example 3층 */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bizAddressDetail?: string;

  /** 업태. 비워 둘 수 있다. @example 도소매업 */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bizCategory?: string;

  /** 종목. 비워 둘 수 있다. @example 제과점 */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bizItem?: string;

  /** 내 사업자정보 조회 응답의 updatedAt 그대로. 그사이 다른 저장이 있었으면 409. */
  @IsUpdatedAt()
  updatedAt: string;

  /** POST /me/bp/business-verification 이 돌려준 10분짜리 토큰. 실으면 그 안의 사업자등록번호 ·
   * 대표자명 · 개업일자와 인증일시를 이 저장과 같은 트랜잭션에서 함께 반영한다(화면이 보낸 값은 믿지
   * 않는다 — admin-signup.service.ts 의 signup 과 같은 규칙). 비우면 인증 쪽 세 값은 그대로 둔다. */
  @IsOptional()
  @IsString()
  businessVerificationToken?: string;
}
