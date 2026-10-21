import { ApiProperty } from '@nestjs/swagger';
import {
  ContractMethod,
  ContractStatus,
  EmploymentType,
  PayslipStatus,
  StatusChangeActor,
  TodoStatus,
} from '@prisma/client';

/** 가장 최근 근로계약의 요약. 직원 목록 · 상세의 contract 와 같은 계약이다 */
export class StaffMemberContractSummaryDto {
  contractId: number;
  /** 계약 유형. 임시저장이면 비어 있을 수 있다 */
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    nullable: true,
  })
  contractMethod: ContractMethod | null;
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  status: ContractStatus | null;
  /** 계약 시작일(YYYY-MM-DD) */
  startDate: string | null;
  /** 계약 종료일(YYYY-MM-DD). 비면 무기한 */
  endDate: string | null;
  /** 최근 발송 일시 — 발송 · 재발송 때 바뀐다. 보낸 적이 없으면 null */
  lastSentAt: Date | null;
  /** 갱신 예정일(YYYY-MM-DD) — 체결 완료이고 종료일이 오늘 이후일 때 종료일 30일 전. 아니면 null */
  renewalDate: string | null;
}

export class StaffMemberContractSummaryResponseDto {
  /** 계약이 없으면 null */
  contract: StaffMemberContractSummaryDto | null;
}

export class StaffMemberWeekScheduleItemDto {
  workScheduleId: number;
  storeId: number;
  storeName: string | null;
  /** 근무일(YYYY-MM-DD) — 시작 일시의 한국 날짜 */
  workDate: string;
  /** 시작 HH:mm(한국 시각) */
  startTime: string;
  /** 종료 HH:mm(한국 시각). 시작보다 이르면 다음 날이다 */
  endTime: string;
  breakMinutes: number;
  /** 근무시간(분) — 종료 − 시작 − 휴게 */
  workMinutes: number;
}

export class StaffMemberWeekScheduleResponseDto {
  /** 그 주 월요일(YYYY-MM-DD) */
  weekStart: string;
  /** 그 주 일요일(YYYY-MM-DD) */
  weekEnd: string;
  /** 시작 일시 순 */
  items: StaffMemberWeekScheduleItemDto[];
  /** 주간 근무시간 합계(분) */
  totalWorkMinutes: number;
}

export class StaffMemberPayslipSummaryDto {
  payslipId: number;
  /** 급여 기간 시작일(YYYY-MM-DD) */
  periodStartDate: string;
  /** 급여 기간 종료일(YYYY-MM-DD) */
  periodEndDate: string;
  @ApiProperty({ enum: PayslipStatus, enumName: 'PayslipStatus' })
  status: PayslipStatus;
  grossPayAmount: number;
  totalDeductionAmount: number;
  netPayAmount: number;
  confirmedAt: Date | null;
}

export class StaffMemberPayslipSummaryResponseDto {
  /** 확정 · 발송 완료 중 급여 기간이 가장 늦은 명세서. 없으면 null */
  latestConfirmed: StaffMemberPayslipSummaryDto | null;
  /** 급여 기간 시작일이 이번 달(한국 날짜)인 명세서. 없으면 null */
  currentMonth: StaffMemberPayslipSummaryDto | null;
  /** 발송 완료가 아닌 명세서 수 — 작성 중 · 검토 중 · 확정 */
  unsentCount: number;
}

export class StaffMemberTodoHistoryDto {
  todoStatusHistoryId: number;
  todoId: number;
  title: string;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus', nullable: true })
  fromStatus: TodoStatus | null;
  @ApiProperty({ enum: TodoStatus, enumName: 'TodoStatus' })
  toStatus: TodoStatus;
  /** 긴급 표시를 바꾼 이력 */
  isUrgentChanged: boolean;
  /** 바꾼 쪽 — 관리자 · 직원 · 시스템. 한 명 수행이면 다른 직원일 수 있어 누구인지는 내지 않는다 */
  @ApiProperty({ enum: StatusChangeActor, enumName: 'StatusChangeActor' })
  actor: StatusChangeActor;
  changedAt: Date;
}

export class StaffMemberTodoSummaryResponseDto {
  /** 이 직원에게 배정된, 지우지 않은 TO-DO 수 */
  total: number;
  doneCount: number;
  notDoneCount: number;
  /**
   * 최근 변경 이력 5건, 바뀐 일시 내림차순. 등록(fromStatus 가 null) · 상태 변경 · 긴급 표시 변경(isUrgentChanged)을 모두
   * 담는다(2026-10-21 노영주)
   */
  recentHistories: StaffMemberTodoHistoryDto[];
}
