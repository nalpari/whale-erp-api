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
 * 연동이 실패하면 던진다 — 「처리 오류」이고 아무것도 저장하지 않는다.
 */
export interface StoreBusinessVerifier {
  verify(identity: BusinessIdentity): Promise<boolean>;
}

/**
 * 진위확인 수단. 국세청 연동이 아직 없어 null 이다 — 인증을 요구하는 요청은 503 이고, 그래서 아무 점포도
 * 운영으로 바꾸지 못한다. 연동을 만들면 StoresModule 의 이 provider 를 그 구현으로 바꾼다.
 */
export const STORE_BUSINESS_VERIFIER = Symbol('STORE_BUSINESS_VERIFIER');

/** STORE_BUSINESS_VERIFIER 로 주입받는 값 — 연동이 없으면 null(첨부파일 저장소의 OptionalStorage 와 같은 모양). */
export type OptionalStoreBusinessVerifier = StoreBusinessVerifier | null;
