import { ApiProperty } from '@nestjs/swagger';
import {
  EmploymentType,
  PayslipItemCategory,
  PayslipLogType,
  PayslipStatus,
} from '@prisma/client';

/** 직원에게 보이는 처리 이력 — 발송 · 확정 취소만(PAY-1). 관리자 이름은 싣지 않는다 */
export class MyPayslipLogDto {
  payslipLogId: number;
  /** SEND · CANCEL_CONFIRMATION 만 온다 */
  @ApiProperty({ enum: PayslipLogType, enumName: 'PayslipLogType' })
  logType: PayslipLogType;
  changedAt: Date;
}

export class MyPayslipItemDto {
  payslipItemId: number;
  @ApiProperty({ enum: PayslipItemCategory, enumName: 'PayslipItemCategory' })
  itemCategory: PayslipItemCategory;
  /** 급여 항목 코드(예: BASE_PAY) */
  itemCode: string;
  /** 발송 당시 항목 이름 */
  itemName: string;
  isTaxFree: boolean;
  calculatedAmount: number | null;
  adjustedAmount: number | null;
  isEntered: boolean;
}

/** 직원 앱 명세서 목록 한 줄 */
export class MyPayslipSummaryDto {
  payslipId: number;
  /** YYYY-MM-DD */
  periodStartDate: string;
  /** YYYY-MM-DD */
  periodEndDate: string;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  /** 늘 SENT — 발송 완료 명세서만 보인다 */
  @ApiProperty({ enum: PayslipStatus, enumName: 'PayslipStatus' })
  status: PayslipStatus;
  grossPayAmount: number;
  totalDeductionAmount: number;
  netPayAmount: number;
  /** 만든 일시 — 보존 기간(3년)의 기준 */
  createdAt: Date;
  /** 근무지 점포 이름 */
  storeName: string;
  /** 발송 · 확정 취소 이력, 최근 것이 위 */
  logs: MyPayslipLogDto[];
}

export class MyPayslipListResponseDto {
  /** 급여 기간이 늦은 것이 위 */
  items: MyPayslipSummaryDto[];
}

/** 직원 앱 명세서 상세 — 목록 줄에 항목을 더한다 */
export class MyPayslipDetailResponseDto extends MyPayslipSummaryDto {
  /** 3.3% 원천징수 적용 — 원천징수 · 소득세 줄을 어떻게 보일지 화면이 정한다 */
  isWithholdingApplied: boolean;
  /** 지급 · 공제 항목, 급여 항목 순서 */
  items: MyPayslipItemDto[];
}
