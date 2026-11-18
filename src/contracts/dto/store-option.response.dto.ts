/** 점포 선택지 한 줄 */
export class StoreOptionDto {
  storeId: number;
  /** 점포명 */
  name: string;
  /** 점포 유형 코드 — DIRECT · FRANCHISE */
  storeTypeCode: string;
  /** 본사 점포인가(2026-11-17) — 가맹 마스터 · 가맹 관리자에게는 나오지 않고, 그 밖의 계정에게는 다른 점포처럼 업무 범위(전체 점포 · 매핑)대로 나온다 */
  isHq: boolean;
}

export class StoreOptionListResponseDto {
  items: StoreOptionDto[];
  total: number;
}
