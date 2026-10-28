import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 위치정보 동의 본문 (ATT-23). 화면이 동의 시트에 보여 준 약관 버전을 싣는다 — 그사이 시행 중인 버전이 바뀌었으면 409 로
 * 거절해, 보인 고지와 남는 동의 버전이 어긋나지 않게 한다(WHALEERP-628, 직원 앱 PR #45 리뷰). 빼거나 null 이면 지금 시행 중인
 * 버전으로 받는다 — 값을 싣지 않는 예전 앱과 맞추려고. 빈 문자열은 400.
 */
export class AgreeLocationConsentDto {
  /** 동의 시트에 보여 준 위치정보 약관 버전 — 예: v1.1 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64) // terms_versions.version 은 길이 제한이 없다 — 운영자가 넣는 「v1.1」 꼴보다 넉넉히
  termsVersion?: string | null;
}
