import { ApiProperty } from '@nestjs/swagger';
import {
  ContractDraftAction,
  ContractMethod,
  ContractStatus,
  EmploymentType,
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

/** 근로계약서 작성 화면을 다시 채울 값 (GET /contracts/:contractId). 칸 이름은 저장 본문과 같다 */
export class ContractDetailDto {
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
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    nullable: true,
  })
  contractMethod: ContractMethod | null;
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
  @ApiProperty({ nullable: true, type: Boolean })
  isHealthPensionInsured: boolean | null;
  @ApiProperty({ nullable: true, type: Boolean })
  isEmploymentInjuryInsured: boolean | null;
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
  @ApiProperty({ type: [ContractDetailWorkDayDto] })
  workDays: ContractDetailWorkDayDto[];
}
