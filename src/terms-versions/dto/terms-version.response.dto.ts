/** 지금 시행 중인 약관 한 유형. */
export class TermsVersionResponseDto {
  /** 약관 유형 코드 — 공통코드 `TERMS_TYPE`. 예: PRIVACY_COLLECT */
  termsTypeCode: string;
  /** 탭 이름 — 공통코드 `TERMS_TYPE` 의 코드명. 예: 개인정보 수집·이용 동의(BP 사업자 회원가입용) */
  label: string;
  /** 본문 제목. 예: [필수] 개인정보 수집·이용 동의 */
  title: string;
  /** 버전 번호. 예: v1.0 */
  version: string;
  /** 시행일(YYYY-MM-DD). 예: 2026-10-01 */
  effectiveDate: string;
}

export class TermsVersionDetailResponseDto extends TermsVersionResponseDto {
  /** 약관 본문(Markdown) */
  content: string;
}

export class TermsVersionListResponseDto {
  /** 약관 유형마다 지금 시행 중인 한 건, 공통코드 `TERMS_TYPE` 정렬 순서. 시행 중인 버전이 없는 유형은 빠진다. */
  items: TermsVersionResponseDto[];
  /** items 개수(페이지를 나누지 않는다) */
  total: number;
}
