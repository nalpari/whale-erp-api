import { ApiProperty } from '@nestjs/swagger';
import { PayslipItemCategory } from '@prisma/client';

/** 「항목 추가」로 붙일 수 있는 추가 공제 — 사용 중인 급여 항목(ADDITIONAL), 순서대로 */
export class PayslipAdditionalItemDto {
  payslipItemMasterId: number;
  itemCode: string;
  name: string;
}

export class PayslipAdditionalItemsResponseDto {
  items: PayslipAdditionalItemDto[];
}

/** 지난 명세서의 한 줄 값 — 넣은 값만(미입력은 싣지 않는다) */
export class PayslipPreviousItemDto {
  payslipItemMasterId: number;
  itemCode: string;
  itemName: string;
  @ApiProperty({ enum: PayslipItemCategory, enumName: 'PayslipItemCategory' })
  itemCategory: PayslipItemCategory;
  amount: number;
}

export class PayslipPreviousDto {
  payslipId: number;
  /** 급여 기간 시작일(YYYY-MM-DD) */
  periodStartDate: string;
  /** 급여 기간 종료일(YYYY-MM-DD) */
  periodEndDate: string;
  /** 공제(기본 · 추가 · 원천징수)와 관리자가 넣는 지급 항목(시스템 계산 항목 제외) */
  items: PayslipPreviousItemDto[];
}

export class PayslipPreviousResponseDto {
  /** 같은 직원의 지난 명세서(급여 기간이 앞선 것 중 가장 늦은 것). 없으면 null */
  previous: PayslipPreviousDto | null;
}
