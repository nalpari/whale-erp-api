import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * 위치정보 동의 본문 (ATT-23). 화면이 동의 시트에 보여 준 약관 버전을 반드시 싣는다 — 그사이 시행 중인 버전이 바뀌었으면 409 로
 * 거절해, 보인 고지와 남는 동의 버전이 어긋나지 않게 한다(WHALEERP-628, 직원 앱 PR #45 · api #185 리뷰). 빼면 400 이다 — 버전을
 * 싣지 않는 예전 앱(열어 둔 탭 · PWA)이 예전 시트로 받은 동의를 새 버전으로 남기지 못하게. null 은 「보인 약관이 없음」이다.
 */
export class AgreeLocationConsentDto {
  /** 동의 시트에 보여 준 위치정보 약관 버전 — 예: v1.1. 시트를 그릴 때 시행 중인 약관이 없었으면 null */
  @ValidateIf((_, value) => value !== null)
  @IsString({
    message: '동의 시트에 보인 약관 버전(termsVersion)을 보내 주세요',
  })
  @IsNotEmpty({
    message: '동의 시트에 보인 약관 버전(termsVersion)을 보내 주세요',
  })
  @MaxLength(64, { message: '약관 버전(termsVersion)은 64자 이하입니다' }) // terms_versions.version 은 길이 제한이 없다 — 운영자가 넣는 「v1.1」 꼴보다 넉넉히
  termsVersion: string | null;
}
