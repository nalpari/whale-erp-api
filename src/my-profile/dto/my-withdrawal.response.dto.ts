/** 탈퇴를 막는 재직 중인 근무지 한 곳 */
export class EmployedStoreDto {
  /** 근무지(점포) 이름 */
  storeName: string;
  /** 퇴직일(YYYY-MM-DD). 값이 있으면 퇴직 예정 — 퇴직일까지 재직이라 탈퇴는 막힌다. 없으면 null */
  retiredDate: string | null;
}

/** 회원 탈퇴 전 보여 줄 조건 (WHALEERP-770) */
export class MyWithdrawalEligibilityResponseDto {
  /** 지금 탈퇴할 수 있는지 — 재직 중인 근무지가 없을 때만 true */
  canWithdraw: boolean;
  /** 가입 완료 · 재직 중인 근무지(퇴직 예정 포함). 하나라도 있으면 탈퇴할 수 없다 */
  employedStores: EmployedStoreDto[];
  /** 탈퇴하면 종료로 닫히는 대기 중 근로계약 수(임시저장 · 발송 대기 · 서명 대기 · 수정 요청) */
  pendingContractCount: number;
}

/**
 * 409 본문 — 재직 중인 근무지가 있어 탈퇴할 수 없다(code `EMPLOYED_AFFILIATION`). 다른 409 와 같은 모양(`statusCode` ·
 * `error` · `code` · `message`)에 막는 근무지를 더한다.
 */
export class MyWithdrawalConflictResponseDto {
  statusCode: number;
  error: string;
  /** `EMPLOYED_AFFILIATION`(재직 중) 일 때만 있다. 교착이 겹친 409 에는 없다 */
  code?: string;
  /** 재직 중이면 「근무지 관리자에게 퇴직 처리를 요청해 주세요.」, 교착이면 「다른 처리와 겹쳐 …」 */
  message: string;
  /** `code` 가 `EMPLOYED_AFFILIATION` 일 때만 있다 */
  employedStores?: EmployedStoreDto[];
}
