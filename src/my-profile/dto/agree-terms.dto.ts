import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  ValidateIf,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const VERSION_MAX = 64; // terms_versions.version 은 길이 제한이 없다 — 위치정보 동의와 같게 넉넉히
const shownVersion = (field: string) =>
  `동의 시트에 보인 약관 버전(${field})을 보내 주세요.`;

/**
 * 약관 동의 본문 (운영 정책 ACC-23, WHALEERP-774). 동의 시트가 보인 직원 앱 약관 셋의 버전을 반드시 싣는다 — 그사이 시행 중인
 * 버전이 바뀌었으면 409 로 거절해 보인 약관과 남는 동의 버전이 어긋나지 않게 한다(위치정보 동의와 같다). 이 요청이 곧 필수 둘
 * (서비스 이용약관 · 개인정보 수집·이용)에 동의하는 것이라 따로 참 · 거짓을 받지 않는다.
 */
export class AgreeTermsDto {
  /** 보인 서비스 이용약관(STAFF_TERMS_SERVICE) 버전 — 예: v1.0 */
  @ApiProperty({ minLength: 1, maxLength: VERSION_MAX })
  @IsString({ message: shownVersion('termsServiceVersion') })
  @IsNotEmpty({ message: shownVersion('termsServiceVersion') })
  @MaxLength(VERSION_MAX)
  termsServiceVersion: string;

  /** 보인 개인정보 수집·이용 동의(STAFF_PRIVACY) 버전 */
  @ApiProperty({ minLength: 1, maxLength: VERSION_MAX })
  @IsString({ message: shownVersion('privacyVersion') })
  @IsNotEmpty({ message: shownVersion('privacyVersion') })
  @MaxLength(VERSION_MAX)
  privacyVersion: string;

  /**
   * 보인 마케팅 정보 수신 동의(MARKETING) 버전 — 동의하지 않아도 싣는다(동의 안 함도 이력에 남는다). 선택 약관이라 시행 중인 것이
   * 없을 수 있다 — 그래서 보인 마케팅 약관이 없었으면 null 이다(위치정보 동의의 termsVersion 과 같다). 빼면 400
   */
  @ApiProperty({
    minLength: 1,
    maxLength: VERSION_MAX,
    nullable: true,
    type: String,
  })
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: shownVersion('marketingVersion') })
  @IsNotEmpty({ message: shownVersion('marketingVersion') })
  @MaxLength(VERSION_MAX)
  marketingVersion: string | null;

  /** [선택] 마케팅 정보 수신 동의 — 빼면 동의하지 않음 */
  @IsOptional()
  @IsBoolean()
  marketingAgreed?: boolean;
}
