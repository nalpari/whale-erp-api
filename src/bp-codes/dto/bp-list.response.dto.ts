export class BpListItemResponseDto {
  bpCodeId: number;
  /** @example BP000012 */
  bpCode: string;
  /** 상호. @example 고래커피 */
  tradeName: string;
  /** 공통코드 `ACCOUNT_STATUS` 값 그대로(사용 · 미사용 · 탈퇴). @example ACTIVE */
  accountStatusCode: string;
}

export class BpListResponseDto {
  /** 최신 등록순. 미삭제 고객 BP 를 상태와 상관없이(withMaster 면 BP 마스터 계정이 있는 BP 만). */
  items: BpListItemResponseDto[];
  total: number;
}
