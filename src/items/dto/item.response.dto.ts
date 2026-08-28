// 응답 타입은 인터페이스가 아니라 클래스여야 한다. 인터페이스는 런타임에
// 사라져 Swagger 가 스키마를 만들 수 없다. 파일명이 *.dto.ts 인 것도 의도적이다.
// Swagger CLI 플러그인이 이 접미사를 가진 파일만 읽어 @ApiProperty 를 대신 채운다.
export class ItemResponseDto {
  /** bigint 라 문자열로 내보낸다. JSON 은 BigInt 를 직렬화하지 못한다. */
  id: string;
  sku: string;
  name: string;
  unit: string;
  /** stock_movements 합계로 유도한 현재 재고. */
  stock: number;
  createdAt: Date;
  updatedAt: Date;
}

export class MovementResponseDto {
  id: string;
  itemId: string;
  /** 입고는 양수, 출고는 음수. */
  quantity: number;
  reason: string;
  /** 이 변동이 반영된 뒤의 재고. */
  stock: number;
  createdAt: Date;
}
