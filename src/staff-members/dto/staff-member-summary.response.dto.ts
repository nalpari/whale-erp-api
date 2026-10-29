import { ApiProperty } from '@nestjs/swagger';
import {
  ContractMethod,
  ContractStatus,
  EmploymentType,
  PayslipStatus,
  StatusChangeActor,
  TodoStatus,
} from '@prisma/client';
import {
  STAFF_SEND_KINDS,
  STAFF_SEND_RESULTS,
  type StaffSendKind,
  type StaffSendResult,
} from '../send-logs';

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
  /**
   * 갱신 예정일(YYYY-MM-DD) — 체결 완료이고 종료일이 오늘 이후일 때 종료일 30일 전. 종료일이 30일 안이면 이미 지난
   * 날짜일 수 있다. 아니면 null
   */
  renewalDate: string | null;
}

/** 신고 정보의 급여 계좌 */
export class StaffMemberPayrollAccountDto {
  /** 은행 이름(BANK 공통코드 이름, 예 KB국민은행). 공통코드에 없으면 은행 코드 그대로 */
  bankName: string;
  /** 계좌번호 전체 — 하이픈 없음, 가리지 않음 */
  accountNumber: string;
}

export class StaffMemberContractSummaryResponseDto {
  /** 계약이 없으면 null */
  contract: StaffMemberContractSummaryDto | null;
  /**
   * 이 관리자가 이 직원의 급여 계좌를 볼 수 있는가. 본사 역할(BP 마스터 · BP 관리자)이 가맹 점포 직원을 보면 false —
   * 본사 제공 동의를 했어도 그렇다(동의 범위에 신고 정보가 없고 계좌는 가맹 점포 사업주가 받는 정보, 운영 정책 TAX-07 ·
   * TAX-08, 재영 2026-10-29). 그 밖(직영 점포 직원, 가맹마스터 · 가맹관리자)은 true. false 이면 화면은 「급여 계좌」 줄
   * 자체를 숨긴다
   */
  canViewPayrollAccount: boolean;
  /**
   * 신고 정보의 급여 계좌 — 은행 이름 · 계좌번호 전체(하이픈 없음, 가리지 않음). 신고 정보가 없으면 null. 계약이 없어도
   * 신고 정보가 있으면 오고, 급여 지급 방식(계좌 · 현금)과 상관없다. canViewPayrollAccount 가 false 이면 신고 정보를
   * 읽지 않고 항상 null
   */
  @ApiProperty({ type: StaffMemberPayrollAccountDto, nullable: true })
  payrollAccount: StaffMemberPayrollAccountDto | null;
}

export class StaffMemberWeekScheduleItemDto {
  workScheduleId: number;
  storeId: number;
  storeName: string;
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

export class StaffMemberRecentPayslipDto {
  payslipId: number;
  /** 급여 기간 시작일(YYYY-MM-DD) */
  periodStartDate: string;
  /** 급여 기간 종료일(YYYY-MM-DD) */
  periodEndDate: string;
  /**
   * 기본급 — 기본급(BASE_PAY) 항목의 관리자 수정값 ?? 시스템 계산값 ?? 0(명세서 지급 총액과 같은 기준). 항목이 없거나
   * 넣지 않은 줄(isEntered = false)이면 null
   */
  basePayAmount: number | null;
  /** 수당 — 지급 총액 − 기본급. 기본급이 null 이면 지급 총액 그대로다(지금은 늘 숫자) */
  allowanceAmount: number | null;
  totalDeductionAmount: number;
  netPayAmount: number;
  @ApiProperty({ enum: PayslipStatus, enumName: 'PayslipStatus' })
  status: PayslipStatus;
}

export class StaffMemberPayslipSummaryResponseDto {
  /** 이 직원의 명세서 최근 3건 — 상태와 관계없이(작성 중 포함) 급여 기간 시작일 최신순, 같으면 명세서 ID 내림차순 */
  recent: StaffMemberRecentPayslipDto[];
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
  /** 완료(DONE) 수 — 한 명 수행은 다른 배정자가 끝내도 완료다 */
  doneCount: number;
  /** 대기 · 진행 중 수. total = doneCount + notDoneCount */
  notDoneCount: number;
  /**
   * 최근 변경 이력 5건, 바뀐 일시 내림차순. 등록(fromStatus 가 null) · 상태 변경 · 긴급 표시 변경(isUrgentChanged)을 모두
   * 담는다(2026-10-21 노영주). 다른 배정자의 퇴직 배정 해제 행은 담지 않는다
   */
  recentHistories: StaffMemberTodoHistoryDto[];
}

/** 발송 이력 한 줄 — 근로계약 발송이 보낸 가입 초대 · 소속 추가 확인 요청 알림톡 한 번(WHALEERP-136) */
export class StaffMemberSendLogDto {
  /** 알림톡 발송 이력 ID(alimtalk_send_logs) */
  sendLogId: number;
  /** 보낸 근로계약 */
  contractId: number;
  @ApiProperty({ enum: STAFF_SEND_KINDS, enumName: 'StaffSendKind' })
  kind: StaffSendKind;
  /** 같은 계약으로 앞서 직원에게 나갔을 수 있는 발송(성공 · 접수 여부 모름)이 있었다 — 재발송 · 고쳐 다시 보냄. 계약 재발송 횟수와는 다를 수 있다 */
  isResend: boolean;
  /** 비즈뿌리오 접수 기준. 접수 여부 모름(UNCONFIRMED)은 다시 보내면 두 번 갈 수 있다 */
  @ApiProperty({ enum: STAFF_SEND_RESULTS, enumName: 'StaffSendResult' })
  result: StaffSendResult;
  /** 관리자에게 보일 실패 사유. 성공이면 null */
  failureReason: string | null;
  /** 다시 보내도 되는가 — 확실히 나가지 않은 실패만 true, 접수 여부 모름은 false. 성공이면 null */
  retryable: boolean | null;
  sentAt: Date;
}

export class StaffMemberSendLogResponseDto {
  /** 이 직원 레코드의 모든 근로계약 발송, 최근 순 */
  items: StaffMemberSendLogDto[];
}
