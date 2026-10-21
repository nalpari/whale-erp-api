import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, Matches, Max, Min } from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { END_TIME_PATTERN, START_TIME_PATTERN } from '../work-schedule-rules';

const MAX_ID = 2_147_483_647;
const DATE_MESSAGE = '근무일은 YYYY-MM-DD 형식의 있는 날짜입니다';

/** 근무일 · 시작 · 종료 · 휴게 — 등록과 수정이 같은 규칙을 쓴다. 시각은 한국 시각 */
export class WorkScheduleFieldsDto {
  /** 근무일 YYYY-MM-DD. 지난 날짜도 받는다 */
  @IsDateOnly(DATE_MESSAGE)
  workDate: string;

  /** 시작 HH:mm, 30분 단위 */
  @Matches(START_TIME_PATTERN, {
    message: '시작은 30분 단위 HH:mm 입니다(00분 · 30분)',
  })
  startTime: string;

  /** 종료 HH:mm, 30분 단위(24:00 까지). 시작보다 이르면 다음 날이다(자정 넘김) */
  @Matches(END_TIME_PATTERN, {
    message: '종료는 30분 단위 HH:mm 입니다(00분 · 30분, 24:00 까지)',
  })
  endTime: string;

  /** 휴게(분). 0 이상, 근무 길이보다 짧게 */
  @IsInt()
  @Min(0)
  @Max(24 * 60)
  breakMinutes: number;
}

export class CreateWorkScheduleDto extends WorkScheduleFieldsDto {
  /** 직원 레코드. 근무지는 그 레코드의 점포다 */
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;
}

/** 수정은 근무일 · 시각 · 휴게를 모두 다시 보낸다. 직원은 못 바꾼다 */
export class UpdateWorkScheduleDto extends WorkScheduleFieldsDto {}

export class WorkScheduleStaffQueryDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId: number;

  /** 근무일 YYYY-MM-DD */
  @IsDateOnly(DATE_MESSAGE)
  workDate: string;
}

export class WorkScheduleDefaultsQueryDto {
  /** 직원 레코드 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 근무일 YYYY-MM-DD */
  @IsDateOnly(DATE_MESSAGE)
  workDate: string;
}

/** 근무스케줄을 받을 수 있는 직원 한 사람 */
export class WorkScheduleStaffItemDto {
  staffMemberId: number;
  name: string;
  /** 휴대전화번호 끝 4자리 — 이름이 같은 직원을 가른다 */
  phoneLast4: string;
  /** 직무(예: 바리스타) */
  jobTitle: string;
}

export class WorkScheduleStaffResponseDto {
  items: WorkScheduleStaffItemDto[];
}

/** 그 근무일 요일의 계약 근무시간. 계약 근무일이 아니면 셋 다 null */
export class WorkScheduleDefaultsDto {
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number | null;
}

export class WorkScheduleDto {
  workScheduleId: number;
  staffMemberId: number;
  storeId: number;
  /** 근무일 — 시작 일시의 한국 날짜 */
  workDate: string;
  /** 시작 HH:mm(한국 시각) */
  startTime: string;
  /** 종료 HH:mm(한국 시각). 시작보다 이르면 다음 날(자정에 끝나면 00:00) */
  endTime: string;
  /** 시작 · 종료 순간(ISO) */
  startAt: string;
  endAt: string;
  breakMinutes: number;
}

export class WorkScheduleDeleteResponseDto {
  workScheduleId: number;
}

export class ListWorkSchedulesQueryDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId: number;

  /** 시작 근무일 YYYY-MM-DD */
  @IsDateOnly(DATE_MESSAGE)
  from: string;

  /** 끝 근무일 YYYY-MM-DD(포함). 시작부터 42일 이하 — 월간 달력 6주 */
  @IsDateOnly(DATE_MESSAGE)
  to: string;
}

/**
 * 기간 안 하루라도 근무스케줄을 받을 수 있는 직원 한 행. 본사 계정에게 가려지는 가맹 직원(ATT-30)은 `isMasked` 이고
 * ID · 이름 · 번호 · 직무 · 고용 형태가 null 이다 — 인원에는 세지만 누구인지는 보이지 않는다. 가린 행은 ID 가 없으니
 * 화면은 행 key 를 배열 순번으로 잡는다.
 */
export class WorkScheduleRosterItemDto {
  staffMemberId: number | null;
  name: string | null;
  /** 휴대전화번호 끝 4자리 */
  phoneLast4: string | null;
  jobTitle: string | null;
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  isMasked: boolean;
  /** 이 직원이 근무스케줄을 받을 수 있는 근무일(YYYY-MM-DD) — 그날 행을 둘지 이것으로 가른다(STAFF-29) */
  schedulableDates: string[];
}

/** 근무일 하나의 인원 — 가린 직원도 센다 */
export class WorkScheduleDayDto {
  workDate: string;
  /** 그날 근무스케줄이 있는 직원 수 */
  headcount: number;
  /** 한국 00:00 부터 30분 칸 48개마다 근무 중인 인원. 전날 시작해 자정을 넘어온 근무도 새벽 칸에 센다(막대 · 인원 수는 시작한 날) */
  coverage: number[];
}

export class WorkScheduleListResponseDto {
  storeId: number;
  from: string;
  to: string;
  staff: WorkScheduleRosterItemDto[];
  items: WorkScheduleDto[];
  days: WorkScheduleDayDto[];
}
