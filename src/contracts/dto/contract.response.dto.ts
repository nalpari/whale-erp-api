import { ApiProperty } from '@nestjs/swagger';
import {
  Gender,
  ContractDocumentKind,
  ContractDraftAction,
  ContractMethod,
  ContractStatus,
  EmploymentType,
  PayMethod,
  PayMonth,
  StatusChangeActor,
  Weekday,
} from '@prisma/client';

/** 근로계약 목록의 한 줄 */
export class ContractListItemDto {
  contractId: number;
  staffMemberId: number;
  /** 직원 레코드의 이름(초안 입력값) */
  staffMemberName: string;
  storeId: number;
  /** 점포가 지워졌어도 이름은 보인다 */
  storeName: string | null;
  // 임시저장한 계약은 아래 칸이 비어 있을 수 있다(근로계약은 키만 NOT NULL).
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
  /** YYYY-MM-DD */
  @ApiProperty({ example: '2026-09-01', nullable: true, type: String })
  startDate: string | null;
  /** YYYY-MM-DD. 비어 있으면 기간의 정함이 없는 계약 */
  @ApiProperty({ example: null, nullable: true, type: String })
  endDate: string | null;
  /** 원. 시급 — 고용 형태와 상관없이 시급이다(2026-10-12) */
  @ApiProperty({ nullable: true, type: Number })
  wageAmount: number | null;
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  status: ContractStatus | null;
  /** 초대 유형 판별 결과(초안 저장 때). 임시저장이면 null */
  @ApiProperty({
    enum: ContractDraftAction,
    enumName: 'ContractDraftAction',
    nullable: true,
  })
  draftAction: ContractDraftAction | null;
  /** 발송 일시 (ISO 8601). 발송 전이면 null */
  @ApiProperty({ nullable: true, type: String })
  sentAt: string | null;
  /** 날인 기한 (ISO 8601) */
  @ApiProperty({ nullable: true, type: String })
  signDeadlineAt: string | null;
}

export class ContractListResponseDto {
  items: ContractListItemDto[];
  /** 거른 결과 전체 건수 */
  total: number;
}

/** 상태 변경 이력 한 줄 */
export class ContractStatusHistoryDto {
  /** 처음 만든 줄은 null */
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  fromStatus: ContractStatus | null;
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  toStatus: ContractStatus;
  @ApiProperty({ enum: StatusChangeActor, enumName: 'StatusChangeActor' })
  actor: StatusChangeActor;
  /** ISO 8601 */
  changedAt: string;
}

/** 근무 요일 한 줄. 시각은 HH:mm */
export class ContractDetailWorkDayDto {
  @ApiProperty({ enum: Weekday, enumName: 'Weekday' })
  weekday: Weekday;
  startTime: string;
  endTime: string;
  @ApiProperty({ nullable: true, type: String })
  breakStartTime: string | null;
  @ApiProperty({ nullable: true, type: String })
  breakEndTime: string | null;
}

/**
 * 계약서에 그리는 근무 조건(contract-terms.ts) — 관리자 상세와 직원 앱 상세(WHALEERP-610)가 같이 쓴다.
 */
export class ContractTermsDto {
  @ApiProperty({ nullable: true, type: String })
  startDate: string | null;
  @ApiProperty({ nullable: true, type: String })
  endDate: string | null;
  @ApiProperty({ nullable: true, type: String })
  workLocation: string | null;
  @ApiProperty({ enum: Weekday, enumName: 'Weekday', nullable: true })
  weeklyHoliday: Weekday | null;
  /** 원. 시급 — 고용 형태와 상관없이 시급이다(2026-10-12) */
  @ApiProperty({ nullable: true, type: Number })
  wageAmount: number | null;
  /** 식대 — 원 */
  @ApiProperty({ nullable: true, type: Number })
  mealAllowanceAmount: number | null;
  /** 자가운전보조금 — 원 */
  @ApiProperty({ nullable: true, type: Number })
  carAllowanceAmount: number | null;
  /** 육아수당 — 원 */
  @ApiProperty({ nullable: true, type: Number })
  childcareAllowanceAmount: number | null;
  /** 월 기본시간 — 시간(0.5 단위) */
  @ApiProperty({ nullable: true, type: Number })
  baseHours: number | null;
  /** 월간 연장근무 — 시간 */
  @ApiProperty({ nullable: true, type: Number })
  monthlyOvertimeHours: number | null;
  /** 기본시간 중 야간근무 — 시간 */
  @ApiProperty({ nullable: true, type: Number })
  baseNightHours: number | null;
  /** 기본시간 중 휴일근무 — 시간. 화면(front #15)에서는 받지 않는다. 칸은 남아 있다 */
  @ApiProperty({ nullable: true, type: Number })
  baseHolidayHours: number | null;
  /** 월간 추가 휴일근무 — 시간. 화면(front #15)에서는 받지 않는다. 칸은 남아 있다 */
  @ApiProperty({ nullable: true, type: Number })
  monthlyExtraHolidayHours: number | null;
  /** 연차휴가 조항 문구 */
  @ApiProperty({ nullable: true, type: String })
  annualLeaveTerms: string | null;
  /** 퇴직금 조항 문구 */
  @ApiProperty({ nullable: true, type: String })
  severancePayTerms: string | null;
  @ApiProperty({ enum: PayMonth, enumName: 'PayMonth', nullable: true })
  payMonth: PayMonth | null;
  @ApiProperty({ nullable: true, type: Number })
  payDay: number | null;
  /** 급여 지급 방식 — 계좌 · 현금 */
  @ApiProperty({ enum: PayMethod, enumName: 'PayMethod', nullable: true })
  payMethod: PayMethod | null;
  /** 수습 기간 — 개월(1~3). 수습이 없으면 null */
  @ApiProperty({ nullable: true, type: Number })
  probationMonths: number | null;
  /** 수습 중 임금 감액률 — %(0~10). 수습이 없으면 null */
  @ApiProperty({ nullable: true, type: Number })
  probationWageReductionRate: number | null;
  @ApiProperty({ nullable: true, type: Boolean })
  isHealthPensionInsured: boolean | null;
  @ApiProperty({ nullable: true, type: Boolean })
  isEmploymentInjuryInsured: boolean | null;
  @ApiProperty({ type: [ContractDetailWorkDayDto] })
  workDays: ContractDetailWorkDayDto[];
}

/** 종이 계약 날인본 한 개. 내려받기는 GET /contracts/:contractId/documents/:contractDocumentId/download-url */
export class ContractDocumentDto {
  contractDocumentId: number;
  /** 종이 계약 근로계약서 · 임금계약서 */
  @ApiProperty({ enum: ContractDocumentKind, enumName: 'ContractDocumentKind' })
  kind: ContractDocumentKind;
  /** 올린 파일의 원래 이름 */
  fileName: string;
}

/** 근로계약서 작성 화면을 다시 채울 값 (GET /contracts/:contractId). 칸 이름은 저장 본문과 같다 */
export class ContractDetailDto extends ContractTermsDto {
  contractId: number;
  staffMemberId: number;
  @ApiProperty({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    nullable: true,
  })
  status: ContractStatus | null;
  name: string;
  phone: string;
  jobTitle: string;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  storeId: number;
  /** 점포가 지워졌어도 이름은 보인다. 점포 행이 없으면 null */
  @ApiProperty({ nullable: true, type: String })
  storeName: string | null;
  /** YYYY-MM-DD */
  @ApiProperty({ nullable: true, type: String })
  birthDate: string | null;
  @ApiProperty({ enum: Gender, enumName: 'Gender', nullable: true })
  gender: Gender | null;
  /** 외국인 여부 — 체크하지 않았으면 false */
  isForeigner: boolean;
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    nullable: true,
  })
  contractMethod: ContractMethod | null;
  /** 초대 유형 판별 결과(초안 저장 때). 임시저장이면 null */
  @ApiProperty({
    enum: ContractDraftAction,
    enumName: 'ContractDraftAction',
    nullable: true,
  })
  draftAction: ContractDraftAction | null;
  /** 상태 변경 이력. 최근 것부터 */
  @ApiProperty({ type: [ContractStatusHistoryDto] })
  histories: ContractStatusHistoryDto[];
  /** 종이 계약 날인본(근로계약서 · 임금계약서). 전자계약 · 임시저장이면 빈 배열 */
  @ApiProperty({ type: [ContractDocumentDto] })
  documents: ContractDocumentDto[];
  /**
   * 처음 보낸 때(ISO 8601) — 상태 이력에서 발송 대기 · 서명 대기로 처음 간 때(WHALEERP-328). 보낸 적 없는 임시저장 · 종이
   * 계약이면 null
   */
  @ApiProperty({ nullable: true, type: String })
  firstSentAt: string | null;
  /** 마지막으로 보낸 때(ISO 8601) — 재발송 · 고쳐 다시 보내면 바뀐다. 보낸 적 없으면 null */
  @ApiProperty({ nullable: true, type: String })
  lastSentAt: string | null;
  /** 날인 기한(ISO 8601) — 마지막으로 보낸 때부터 30일. 보낸 적 없으면 null */
  @ApiProperty({ nullable: true, type: String })
  signDeadlineAt: string | null;
  /** 최종 처리일(ISO 8601) — 가장 최근 상태 변경 일시. 이력이 없으면 null */
  @ApiProperty({ nullable: true, type: String })
  lastProcessedAt: string | null;
  /** 직원이 남긴 거부 사유 — 거부된 계약에만, 그 밖은 null */
  @ApiProperty({ nullable: true, type: String })
  rejectReason: string | null;
  /** 재발송 횟수 — 처음 발송 뒤 다시 보낸 횟수(재발송 · 고쳐 다시 보냄). 이 칸이 생기기 전의 재발송은 세지 않았다 */
  resendCount: number;
  /** 재계약으로 만든 계약이면 직전 계약 ID. 재계약(WHALEERP-156) 전이라 지금은 늘 null */
  @ApiProperty({ nullable: true, type: Number })
  previousContractId: number | null;
  /** 종이 계약 등록일(ISO 8601) — 체결 완료가 된 때. 종이 계약만, 전자계약은 null */
  @ApiProperty({ nullable: true, type: String })
  registeredAt: string | null;
  /**
   * 종이 계약을 작성한 관리자 — 종이 계약만, 전자계약은 null. 이름이 없으면 로그인 아이디. 임시저장을 다른 관리자가 이어 써 등록했어도
   * 처음 작성한 관리자다(상태 이력은 관리자를 남기지 않는다)
   */
  @ApiProperty({ nullable: true, type: String })
  registeredBy: string | null;
  /**
   * 재발송(POST …/send)할 수 있는가 — 발송 대기 · 서명 대기이고, 가입한 직원이거나 그 번호로 계정이 없는 가입 전 직원. 계정이
   * 있는 번호(소속 추가 확인 · 복귀 확인)는 409 SEND_CHANNEL_NOT_READY 라 false. 상세 화면이 재발송 버튼을 이 값으로 보인다
   */
  canResend: boolean;
}
