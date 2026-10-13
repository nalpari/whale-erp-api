import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType, PayMonth, Weekday } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// 30분 단위 시각 (운영 정책 CTR-20). DB CHECK 도 같은 것을 본다.
const HALF_HOUR = /^([01]\d|2[0-3]):(00|30)$/;
const HALF_HOUR_MESSAGE = '시각은 HH:mm, 30분 단위입니다';

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
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  /** 숫자만 10~11자리 (예: 01090145563) */
  @Matches(/^[0-9]{10,11}$/, { message: '휴대전화번호는 숫자 10~11자리입니다' })
  phone: string;

  /** YYYY-MM-DD. 계약 시작일 기준 만 19세 미만이면 저장하지 않는다 */
  @unlessTemporary
  @IsDateString({ strict: true })
  birthDate?: string;

  @IsInt()
  @Min(1)
  storeId: number;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  jobTitle: string;

  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  @IsEnum(EmploymentType)
  employmentType: EmploymentType;

  @ApiProperty({ enum: ['ELECTRONIC'] })
  @IsIn(['ELECTRONIC'], { message: '지금은 전자계약만 저장할 수 있습니다' })
  contractMethod: 'ELECTRONIC';

  /** YYYY-MM-DD */
  @unlessTemporary
  @IsDateString({ strict: true })
  startDate?: string;

  /** YYYY-MM-DD. 비우면 기간의 정함이 없는 계약 */
  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  /** 원. 시급 — 고용 형태와 상관없이 시급만 받는다(2026-10-12) */
  @unlessTemporary
  @IsInt()
  @Min(1)
  wageAmount?: number;

  // 주휴일은 받지 않는다 — 근무 요일 · 시간으로 서버가 정한다(contracts.service weeklyHolidayOf).

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
}

export class CreatedContractResponseDto {
  contractId: number;
  staffMemberId: number;
}
