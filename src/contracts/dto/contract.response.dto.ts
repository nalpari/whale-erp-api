import { ApiProperty } from '@nestjs/swagger';
import {
  ContractDraftAction,
  ContractMethod,
  ContractStatus,
  EmploymentType,
  PayMonth,
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
  /** 원. 정직원은 월급, 파트타이머는 시급 — employmentType 이 정한다 */
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
  @ApiProperty({ nullable: true, type: Number })
  wageAmount: number | null;
  @ApiProperty({ enum: PayMonth, enumName: 'PayMonth', nullable: true })
  payMonth: PayMonth | null;
  @ApiProperty({ nullable: true, type: Number })
  payDay: number | null;
  @ApiProperty({ nullable: true, type: Boolean })
  isHealthPensionInsured: boolean | null;
  @ApiProperty({ nullable: true, type: Boolean })
  isEmploymentInjuryInsured: boolean | null;
  @ApiProperty({ type: [ContractDetailWorkDayDto] })
  workDays: ContractDetailWorkDayDto[];
}
