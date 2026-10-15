/** 점포 선택지 한 줄 */
export class StoreOptionDto {
  storeId: number;
  /** 점포명 */
  name: string;
}

export class StoreOptionListResponseDto {
  items: StoreOptionDto[];
  total: number;
}
