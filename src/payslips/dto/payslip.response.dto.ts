import { ApiProperty } from '@nestjs/swagger';
import {
  ContractStatus,
  DispatchResult,
  EmploymentType,
  PayslipDispatchChannel,
  PayslipItemCategory,
  PayslipLogType,
  PayslipReviewReasonValue,
  PayslipStatus,
} from '@prisma/client';

/**
 * 목록 한 줄. isMasked 면 본사 제공 동의가 없는 가맹 점포 직원의 명세서이고(BP 마스터 · BP 관리자에게만, ATT-30),
 * 근무지 · 급여 기간 · isMasked 밖의 칸은 payslipId 까지 모두 null 이다 — 상세로 가지 못한다.
 */
export class PayslipListItemDto {
  payslipId: number | null;
  isMasked: boolean;
  staffName: string | null;
  storeId: number;
  storeName: string;
  /** 급여 기간 시작일(YYYY-MM-DD) */
  periodStartDate: string;
  /** 급여 기간 종료일(YYYY-MM-DD) */
  periodEndDate: string;
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  /**
   * 출퇴근 확인 여부. 검토 대기 사유 「출퇴근 누락」(MISSING_ATTENDANCE)이 없거나 확인(acknowledgedAt)됐으면 true,
   * 확인 전이면 false. 누락 일수는 스키마에 칸이 없어(사유 상세는 글자) 내지 않는다
   */
  isAttendanceConfirmed: boolean | null;
  @ApiProperty({
    enum: PayslipStatus,
    enumName: 'PayslipStatus',
    nullable: true,
  })
  status: PayslipStatus | null;
  /** 발송일 — 성공한 발송 이력 중 가장 늦은 시각. 발송 전이면 null */
  lastSentAt: Date | null;
  /**
   * 확인하지 않은 검토 사유(검토 대기 — WHALEERP-234). 하나라도 있으면 검토 대기다. 사유 넷 — 출퇴근 누락 · 계약 만료 후 기록 ·
   * 기간 중 계약 변경 · 확인 필요 기록 포함 — 의 순서. 가린 줄은 null
   */
  @ApiProperty({
    enum: PayslipReviewReasonValue,
    enumName: 'PayslipReviewReason',
    isArray: true,
    nullable: true,
  })
  pendingReviewReasons: PayslipReviewReasonValue[] | null;
}

/** 상태 건수 — 작성 중 · 검토 중 · 확정 · 발송 완료 */
export class PayslipStatusCountsDto {
  DRAFTING: number;
  REVIEWING: number;
  CONFIRMED: number;
  SENT: number;
}

export class PayslipListResponseDto {
  items: PayslipListItemDto[];
  /** 모든 필터(상태 · 점포 · 직원명)를 건 건수(페이지 수 계산용) */
  total: number;
  /** 그 달 · 관리 범위의 상태 건수. 상태 필터와 상관없고 점포 · 직원명 필터는 따른다 — 직원명으로 거르면 가린 줄은 빼고, 아니면 가린 줄도 센다 */
  statusCounts: PayslipStatusCountsDto;
  /** 상태 건수와 같은 범위에서 검토 대기 명세서 수 — 관리자 웹 건수 줄 끝 「· 검토 대기 N」(가린 줄도 센다, 검토 대기만 거른 목록에서는 빠진다) */
  reviewPendingCount: number;
}

/** 명세서 금액 한 줄. 금액은 adjustedAmount ?? calculatedAmount, 아직 넣지 않았으면 isEntered = false */
export class PayslipItemDto {
  payslipItemId: number;
  @ApiProperty({ enum: PayslipItemCategory, enumName: 'PayslipItemCategory' })
  itemCategory: PayslipItemCategory;
  payslipItemMasterId: number;
  /** 급여 항목 코드(예: BASE_PAY) */
  itemCode: string;
  /** 발송 당시 항목 이름 */
  itemName: string;
  isTaxFree: boolean;
  /** 시스템 계산값 — 지급 항목만 */
  calculatedAmount: number | null;
  /** 관리자 수정값 */
  adjustedAmount: number | null;
  /** 입력 여부 — 공제 미입력과 0 을 가른다 */
  isEntered: boolean;
}

export class PayslipReviewReasonDto {
  payslipReviewReasonId: number;
  @ApiProperty({
    enum: PayslipReviewReasonValue,
    enumName: 'PayslipReviewReason',
  })
  reviewReason: PayslipReviewReasonValue;
  /** 상세 — 누락 일수 등(글자) */
  detail: string | null;
  acknowledgedAt: Date | null;
}

export class PayslipLogDto {
  payslipLogId: number;
  @ApiProperty({ enum: PayslipLogType, enumName: 'PayslipLogType' })
  logType: PayslipLogType;
  @ApiProperty({
    enum: PayslipStatus,
    enumName: 'PayslipStatus',
    nullable: true,
  })
  fromStatus: PayslipStatus | null;
  @ApiProperty({
    enum: PayslipStatus,
    enumName: 'PayslipStatus',
    nullable: true,
  })
  toStatus: PayslipStatus | null;
  summary: string;
  /** 처리한 관리자 ID. 시스템 처리는 null */
  changedBy: number | null;
  /** 처리한 관리자 이름. 시스템 처리 · 이름 없는 계정은 null */
  changedByName: string | null;
  changedAt: Date;
}

/** 발송 이력 한 줄 — 채널마다 한 줄 */
export class PayslipDispatchDto {
  payslipDispatchId: number;
  @ApiProperty({
    enum: PayslipDispatchChannel,
    enumName: 'PayslipDispatchChannel',
  })
  channel: PayslipDispatchChannel;
  @ApiProperty({ enum: DispatchResult, enumName: 'DispatchResult' })
  status: DispatchResult;
  sentAt: Date;
}

/** 참조한 근로계약 */
export class PayslipContractDto {
  contractId: number;
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  status: ContractStatus | null;
  wageAmount: number | null;
}

/** 명세서 상세(GET /payslips/:id). 가려지는 명세서는 404 라 늘 직원 이름이 있다 */
export class PayslipDetailResponseDto {
  payslipId: number;
  staffMemberId: number;
  staffName: string;
  storeId: number;
  storeName: string;
  contractId: number;
  /** YYYY-MM-DD */
  periodStartDate: string;
  /** YYYY-MM-DD */
  periodEndDate: string;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  @ApiProperty({ enum: PayslipStatus, enumName: 'PayslipStatus' })
  status: PayslipStatus;
  isPremiumApplied: boolean;
  isWithholdingApplied: boolean;
  grossPayAmount: number;
  totalDeductionAmount: number;
  /** 실지급액 */
  netPayAmount: number;
  /** 출퇴근 참조 시작일(YYYY-MM-DD) */
  attendanceStartDate: string;
  /** 출퇴근 참조 종료일(YYYY-MM-DD) */
  attendanceEndDate: string;
  /** 목록과 같은 출퇴근 확인 여부 */
  isAttendanceConfirmed: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contract: PayslipContractDto;
  /** 지급 · 공제 항목, 급여 항목 순서 */
  items: PayslipItemDto[];
  /** 검토 대기 사유 */
  reviewReasons: PayslipReviewReasonDto[];
  /** 처리 이력, 최근 것이 위 */
  logs: PayslipLogDto[];
  /** 발송 이력, 보낸 순서 */
  dispatches: PayslipDispatchDto[];
}
