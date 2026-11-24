import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';

/**
 * 작성 대상 한 줄 — 관리 범위의 직원 한 명. 본사 제공 동의 없는 가맹 점포 직원은 본사 역할에게 줄째 빠진다(ATT-30,
 * 작성할 수 없어 가린 줄을 둘 까닭이 없다).
 */
export class PayslipCandidateDto {
  staffMemberId: number;
  staffName: string;
  storeId: number;
  storeName: string;
  /** 본사 점포(stores.is_hq) — 화면은 「[본사] 상호」로 보인다 */
  storeIsHq: boolean;
  /** 계약 유형 — 유효한 근로계약의 값, 없으면 직원 레코드의 값 */
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  /** 급여 기간에 걸친 서명 완료 근로계약 중 가장 늦게 시작한 것. 없으면 null — 초안을 만들 수 없다 */
  contractId: number | null;
  /** 이 달 명세서가 이미 있으면 그 ID — 새로 만들지 않는다 */
  payslipId: number | null;
  /** 급여 기간에 출퇴근 기록이 한 건이라도 있는가. 없으면 초안에 「출퇴근 누락」 검토 사유가 붙는다 */
  hasAttendance: boolean;
  /**
   * 직원 레코드의 퇴직일(staff_members.retired_date, YYYY-MM-DD). 없으면 null. 화면은 오늘(한국) 전이면 「퇴직」, 오늘 이후면
   * 「퇴직 예정」으로 보인다 — 퇴직한 달 마지막 급여(근로기준법 제36조 14일 안 청산)를 가리려는 것이다
   */
  retiredDate: string | null;
}

export class PayslipCandidatesResponseDto {
  /** 급여 기간 시작일(YYYY-MM-DD) */
  periodStartDate: string;
  /** 급여 기간 종료일(YYYY-MM-DD) */
  periodEndDate: string;
  items: PayslipCandidateDto[];
}

export class PayslipCreatedDto {
  payslipId: number;
}

export class PayslipBulkCreatedItemDto {
  payslipId: number;
  staffMemberId: number;
  staffName: string;
  /** 출퇴근 기록이 없어 「출퇴근 누락」 검토 사유를 붙였는가 */
  hasMissingAttendance: boolean;
}

export const PAYSLIP_SKIP_REASONS = ['EXISTS', 'NO_CONTRACT'] as const;
export type PayslipSkipReason = (typeof PAYSLIP_SKIP_REASONS)[number];

export class PayslipBulkSkippedItemDto {
  staffMemberId: number;
  staffName: string;
  /** EXISTS — 이 달 명세서가 이미 있음 · NO_CONTRACT — 급여 기간에 유효한 근로계약 없음 */
  @ApiProperty({ enum: PAYSLIP_SKIP_REASONS, enumName: 'PayslipSkipReason' })
  reason: PayslipSkipReason;
}

export class PayslipBulkCreateResponseDto {
  created: PayslipBulkCreatedItemDto[];
  skipped: PayslipBulkSkippedItemDto[];
}
