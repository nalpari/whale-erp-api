import { ApiProperty } from '@nestjs/swagger';
import {
  Gender,
  ContractDraftAction,
  ContractMethod,
  ContractStatus,
  EmploymentType,
  PayMethod,
  PayMonth,
  Weekday,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';

// 30분 단위 시각 (운영 정책 CTR-20). DB CHECK 도 같은 것을 본다.
const HALF_HOUR = /^([01]\d|2[0-3]):(00|30)$/;
const HALF_HOUR_MESSAGE = '시각은 HH:mm, 30분 단위입니다';
const DATE_MESSAGE = '날짜는 YYYY-MM-DD 형식의 있는 날짜여야 합니다';
// integer 컬럼의 상한. 넘는 값을 DB 에 보내면 400 이 아니라 500 이 된다.
const MAX_INT = 2_147_483_647;
// numeric(5,1) 의 상한을 30분 단위로 내린 값.
const MAX_HOURS = 9999.5;

/** 월 근로시간 — 0 이상, 30분(0.5시간) 단위. numeric(5,1) 에 들어간다 */
const HalfHours = () =>
  ValidateBy({
    name: 'halfHours',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'number' &&
        v >= 0 &&
        v <= MAX_HOURS &&
        Number.isInteger(v * 2),
      defaultMessage: () =>
        '근로시간은 0 이상, 30분(0.5시간) 단위의 시간입니다',
    },
  });

/** 근무하는 요일 하나. 휴게는 둘 다 넣거나 둘 다 비운다 */
export class ContractWorkDayDto {
  @ApiProperty({ enum: Weekday, enumName: 'Weekday' })
  @IsEnum(Weekday)
  weekday: Weekday;

  /** 시업 HH:mm */
  @Matches(HALF_HOUR, { message: HALF_HOUR_MESSAGE })
  startTime: string;

  /** 종업 HH:mm. 시업보다 뒤, 같은 날 안 */
  @Matches(HALF_HOUR, { message: HALF_HOUR_MESSAGE })
  endTime: string;

  @IsOptional()
  @Matches(HALF_HOUR, { message: HALF_HOUR_MESSAGE })
  breakStartTime?: string;

  @IsOptional()
  @Matches(HALF_HOUR, { message: HALF_HOUR_MESSAGE })
  breakEndTime?: string;
}

// 임시저장이면 계약 칸은 비워도 된다(근로계약은 키만 NOT NULL). 넣은 값은 똑같이 검사한다.
// 직원 레코드 칸(이름 · 번호 · 직무 · 고용 형태)과 근무지는 staff_members 가 NOT NULL 이라 늘 필수다.
const unlessTemporary = ValidateIf(
  (o: CreateContractDto, v: unknown) => !o.isTemporarySave || v !== undefined,
);

/**
 * 근로계약서 초안. 저장하면 미가입 직원 레코드와 발송 대기(임시저장이면 임시저장) 계약이 생긴다.
 * 초대 유형 판별 · 발송과 종이 계약(날인본 파일)은 아직 없다 — 전자계약만 받는다.
 */
export class CreateContractDto {
  /** 앞뒤 공백은 지운다(NFC) — 같은 사람의 가입 전 레코드를 이름으로 찾으므로 공백 하나로 갈리지 않게. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  /** 숫자만 10~11자리 (예: 01090145563) */
  @Matches(/^[0-9]{10,11}$/, { message: '휴대전화번호는 숫자 10~11자리입니다' })
  phone: string;

  /** YYYY-MM-DD. 계약 시작일 기준 만 19세 미만이면 저장하지 않는다 */
  @unlessTemporary
  @IsDateOnly(DATE_MESSAGE)
  birthDate?: string;

  /** 성별 — 남 · 여. 가입 때 직원이 넣은 값과 본인 대조한다(WHALEERP-125). 임시저장은 비워도 된다 */
  @ApiProperty({ enum: Gender, enumName: 'Gender', required: false })
  @unlessTemporary
  @IsEnum(Gender)
  gender?: Gender;

  /** 외국인 여부 — 체크하지 않으면 내국인(false). 본인 대조에 쓴다(WHALEERP-125) */
  @IsOptional()
  @IsBoolean()
  isForeigner?: boolean;

  @IsInt()
  @Min(1)
  @Max(MAX_INT)
  storeId: number;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  jobTitle: string;

  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  @IsEnum(EmploymentType)
  employmentType: EmploymentType;

  /**
   * 전자계약 · 종이 계약. 임시저장이면 비워도 된다. 종이 계약은 날인본 파일과 함께 `POST /contracts/paper`
   * (이어 쓰기는 `PUT /contracts/:contractId/paper`)로 등록하고 체결 완료가 된다(CTR-23). 여기(JSON)로는 임시저장만 된다.
   */
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    required: false,
  })
  @unlessTemporary
  @IsEnum(ContractMethod, {
    message: '계약 방식은 전자계약 · 종이 계약 중 하나입니다',
  })
  contractMethod?: ContractMethod;

  /** YYYY-MM-DD */
  @unlessTemporary
  @IsDateOnly(DATE_MESSAGE)
  startDate?: string;

  /** YYYY-MM-DD. 비우면 기간의 정함이 없는 계약 */
  @IsOptional()
  @IsDateOnly(DATE_MESSAGE)
  endDate?: string;

  /** 원. 시급 — 고용 형태와 상관없이 시급만 받는다(2026-10-12) */
  @unlessTemporary
  @IsInt()
  @Min(1)
  @Max(MAX_INT)
  wageAmount?: number;

  // 계약서 임금 · 근로시간 조항 (현업 요구사항, 2026-10-12 재영). 모두 비울 수 있다.

  /** 식대 — 원, 비과세 수당 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  mealAllowanceAmount?: number;

  /** 자가운전보조금 — 원, 비과세 수당 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  carAllowanceAmount?: number;

  /** 육아수당 — 원, 비과세 수당 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  childcareAllowanceAmount?: number;

  /** 월 기본시간 — 시간, 30분 단위 */
  @IsOptional()
  @IsNumber()
  @HalfHours()
  baseHours?: number;

  /** 월간 연장근무 — 시간, 30분 단위 */
  @IsOptional()
  @IsNumber()
  @HalfHours()
  monthlyOvertimeHours?: number;

  /** 기본시간 중 야간근무 — 시간, 30분 단위 */
  @IsOptional()
  @IsNumber()
  @HalfHours()
  baseNightHours?: number;

  /** 기본시간 중 휴일근무 — 시간, 30분 단위. 화면(front #15)에서는 받지 않는다. 칸은 남아 있다 */
  @IsOptional()
  @IsNumber()
  @HalfHours()
  baseHolidayHours?: number;

  /** 월간 추가 휴일근무 — 시간, 30분 단위. 화면(front #15)에서는 받지 않는다. 칸은 남아 있다 */
  @IsOptional()
  @IsNumber()
  @HalfHours()
  monthlyExtraHolidayHours?: number;

  /** 연차휴가 조항 문구. 기본 문구는 작성 화면이 채운다 */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  annualLeaveTerms?: string;

  /** 퇴직금 조항 문구. 기본 문구는 작성 화면이 채운다 */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  severancePayTerms?: string;

  /**
   * 주휴일 — 근무하지 않는 요일 하나(노무사 확인 2026-10-14). 주 소정근로시간이 15시간 이상이면 넣어야 하고,
   * 15시간 미만이면 주휴가 없어 비운다(contracts.service checkWeeklyHoliday).
   */
  @ApiProperty({ enum: Weekday, enumName: 'Weekday', required: false })
  @IsOptional()
  @IsEnum(Weekday)
  weeklyHoliday?: Weekday;

  @ApiProperty({ type: [ContractWorkDayDto], required: false })
  @unlessTemporary
  @ValidateNested({ each: true })
  @Type(() => ContractWorkDayDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  workDays?: ContractWorkDayDto[];

  @ApiProperty({ enum: PayMonth, enumName: 'PayMonth', required: false })
  @unlessTemporary
  @IsEnum(PayMonth)
  payMonth?: PayMonth;

  /** 1~31. 31 은 말일 */
  @unlessTemporary
  @IsInt()
  @Min(1)
  @Max(31)
  payDay?: number;

  /** 급여 지급 방식 — 계좌 · 현금 */
  @ApiProperty({ enum: PayMethod, enumName: 'PayMethod', required: false })
  @unlessTemporary
  @IsEnum(PayMethod)
  payMethod?: PayMethod;

  /**
   * 수습 기간 — 개월, 1~3. 비우면 수습 없음. 정직원이고 계약 기간이 1년 이상이거나 기간의 정함이 없을 때만 둔다
   * (노무사 확인 2026-10-14). 감액률과 함께 넣는다.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  probationMonths?: number;

  /** 수습 중 임금 감액률 — %, 0~10. 수습 중 시급 = 시급 × (1 − 감액률). 수습 기간과 함께 넣는다 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  probationWageReductionRate?: number;

  /** 계약서 근무 장소 조항에 적는 주소. 근무지 점포와 따로다 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  workLocation?: string;

  @unlessTemporary
  @IsBoolean()
  isHealthPensionInsured?: boolean;

  @unlessTemporary
  @IsBoolean()
  isEmploymentInjuryInsured?: boolean;

  /** true 면 임시저장(DRAFT) — 초대 · 계약서를 보내지 않는다. 없으면 초안 저장(발송 대기) */
  @IsOptional()
  @IsBoolean()
  isTemporarySave?: boolean;

  /**
   * 대체할 진행 중 계약(WHALEERP-129). 같은 점포에 같은 번호의 진행 중 계약(임시저장 · 발송 대기 · 서명 대기 · 수정 요청)이
   * 있으면 409(code CONTRACT_IN_PROGRESS)가 그 목록(id · 상태 · 직원 이름 · 계약 기간)을 준다. 관리자가 대체를 확인하면
   * 그 id 를 모두 넣어 다시 보낸다 — 임시저장은 지우고 발송 대기 · 서명 대기 · 수정 요청은 종료한다. 종이 계약 등록이면 체결 완료도
   * 묻고 종료한다. 체결 완료는 같은 번호로 퇴직 · 재입사가 되풀이되면 쌓이므로 상한을 넉넉히 둔다 — 409 목록을 모두
   * 다시 보낼 수 없으면 그 번호로는 종이 계약을 등록할 수 없다(api #49 리뷰, WHALEERP-600).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_INT, { each: true })
  replaceContractIds?: number[];
}

export class CreatedContractResponseDto {
  contractId: number;
  staffMemberId: number;
  /** 저장한 뒤의 상태 — 임시저장 · 발송 대기 · 서명 대기 · 체결 완료(종이 계약) 등 */
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  status: ContractStatus;
  /**
   * 시스템이 실제로 한 처리(WHALEERP-132). 보내지 않은 저장(임시저장 · 종이 계약 등록)은 null, 가입한 직원에게 앱으로 보냈으면
   * 즉시 발송(IMMEDIATE_SEND), 아니면 판별한 초대 유형 — 가입 초대(알림톡) · 소속 추가 확인 · 복귀 확인(소속 · 복귀를 확인하기
   * 전까지 직원에게 알림이 가지 않는다). 보내기 전에 다른 요청이 초대를 무효로 해 되돌렸거나, 판별값이 없는 옛 계약의 가입 전
   * 직원이라 나간 것이 없으면 null(상태는 지금 상태). 계약에 저장한 draftAction(상세 · 목록)과 다를 수 있다
   */
  @ApiProperty({
    enum: ContractDraftAction,
    enumName: 'ContractDraftAction',
    nullable: true,
  })
  draftAction: ContractDraftAction | null;
}
