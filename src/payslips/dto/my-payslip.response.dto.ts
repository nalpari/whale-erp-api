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
  /** 근무지 점포 ID */
  storeId: number;
  /** 근무지 점포 이름 */
  storeName: string;
  /** 받은 날 — 가장 최근 발송 시각(다시 보냈으면 그때). 발송 이력이 없으면 null */
  sentAt: Date | null;
  /** 발송 · 확정 취소 이력, 최근 것이 위 */
  logs: MyPayslipLogDto[];
}

/** 맨 위 카드 — 이번 달(한국 시간)에 받은 명세서. 필터와 관계없고 근무지와 관계없이 모두 센다(PAY-9 · PAY-8) */
export class MyPayslipThisMonthDto {
  /** YYYY-MM — 한국 시간 기준 이번 달 */
  month: string;
  /** 받은 명세서 수. 0 이면 앱이 「이번 달에 받은 명세서가 없습니다」를 적는다 */
  count: number;
  /** 실지급액 합계 */
  totalNetPayAmount: number;
  /** 받은 명세서의 점포 이름 — 겹치지 않게, 최근에 받은 것부터 */
  storeNames: string[];
}

/** 점포 필터에 고를 점포 — 명세서를 받은 적이 있는 곳 모두, 퇴직한 곳도(PAY-10) */
export class MyPayslipStoreDto {
  storeId: number;
  storeName: string;
}

export class MyPayslipListResponseDto {
  thisMonth: MyPayslipThisMonthDto;
  /** 이름순 */
  stores: MyPayslipStoreDto[];
  /** 점포 · 연도로 거른 명세서, 최근에 받은(발송일) 것이 위 */
  items: MyPayslipSummaryDto[];
}

/** 직원 앱 명세서 상세 — 목록 줄에 항목을 더한다 */
export class MyPayslipDetailResponseDto extends MyPayslipSummaryDto {
  /** 3.3% 원천징수 적용 — 원천징수 · 소득세 줄을 어떻게 보일지 화면이 정한다 */
  isWithholdingApplied: boolean;
  /** 지급 · 공제 항목, 급여 항목 순서 */
  items: MyPayslipItemDto[];
}
