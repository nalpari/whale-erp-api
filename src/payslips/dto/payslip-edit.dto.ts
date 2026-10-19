import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';

const MAX_INT = 2_147_483_647;
/** 한 줄 금액 상한(원). 줄을 더한 합계가 integer 칸을 넘지 않게 낮게 둔다 — 합계도 따로 본다 */
export const PAYSLIP_AMOUNT_MAX = 100_000_000;

/** 명세서 한 줄의 금액. null 은 미입력이고 0 과 다르다(공제 대상이 아니면 0 을 넣는다). */
export class PayslipItemAmountDto {
  @IsInt()
  @Min(1)
  @Max(MAX_INT)
  payslipItemMasterId: number;

  /** 원, 0 이상. null 이면 미입력 — 시스템 계산 항목은 계산값으로 돌아간다 */
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: PAYSLIP_AMOUNT_MAX,
  })
  @ValidateIf((o: PayslipItemAmountDto) => o.amount !== null)
  @IsInt()
  @Min(0)
  @Max(PAYSLIP_AMOUNT_MAX)
  amount: number | null;
}

/**
 * 임시저장 (WHALEERP-228). 지급 · 기본 공제 · 원천징수 줄은 실은 것만 고치고(빠진 줄은 그대로), 추가 공제는 실은 것이
 * 곧 붙은 목록이다 — 새 항목은 붙이고, 빠진 것은 뗀다.
 */
export class SavePayslipDto {
  /** 상세 응답의 updatedAt 그대로 — 그사이 누가 고쳤으면 409 */
  @IsUpdatedAt()
  updatedAt: string;

  /** 연장 · 야간 · 휴일 가산 적용(PAY-05) */
  @IsBoolean()
  isPremiumApplied: boolean;

  /** 3.3% 원천징수 적용(PAY-03). 파트타이머 명세서만 켤 수 있다 — 정직원이 true 면 400 */
  @IsBoolean()
  isWithholdingApplied: boolean;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PayslipItemAmountDto)
  items: PayslipItemAmountDto[];
}

/** 확정 · 확정 취소 (WHALEERP-230) */
export class PayslipStatusChangeDto {
  /** 상세 응답의 updatedAt 그대로 — 그사이 누가 고쳤으면 409 */
  @IsUpdatedAt()
  updatedAt: string;
}
