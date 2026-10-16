/** 국세청 사업자등록 진위확인에 넣는 세 값. */
export type BusinessIdentity = {
  /** 숫자 10자리 */
  bizRegistrationNumber: string;
  ceoName: string;
  /** 개업일자(UTC 자정 Date) */
  openDate: Date;
};

/**
 * 사업자등록 진위확인. 세 값이 국세청에 등록된 것과 맞으면 true, 아니면 false(「확인 불가」).
 * 연동이 실패하면 던진다 — 「처리 오류」이고 아무것도 저장하지 않는다. 던지는 오류의 message 에 요청 값(특히
 * 대표자명)을 넣지 않는다 — 서비스가 그 stack 을 로그에 남긴다.
 */
export interface StoreBusinessVerifier {
  verify(identity: BusinessIdentity): Promise<boolean>;
}

/**
 * 진위확인 수단. StoresModule 은 회원가입과 같은 국세청 클라이언트(NtsStoreBusinessVerifier)를 넣고, NTS_SERVICE_KEY 가
 * 없으면(키가 없으면 — 운영도 기동하고 error 로그만 남긴다) null 을 넣는다. null 이면 인증을 요구하는 요청은 503 이고, 그래서
 * 아무 점포도 운영으로 바꾸지 못한다.
 */
export const STORE_BUSINESS_VERIFIER = Symbol('STORE_BUSINESS_VERIFIER');

/** STORE_BUSINESS_VERIFIER 로 주입받는 값 — 연동이 없으면 null(첨부파일 저장소의 OptionalStorage 와 같은 모양). */
export type OptionalStoreBusinessVerifier = StoreBusinessVerifier | null;
