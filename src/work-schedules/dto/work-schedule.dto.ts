import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentType, WorkScheduleChangeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { END_TIME_PATTERN, START_TIME_PATTERN } from '../work-schedule-rules';

const MAX_ID = 2_147_483_647;
const DATE_MESSAGE = '근무일은 YYYY-MM-DD 형식의 있는 날짜입니다.';

/** 근무일 · 시작 · 종료 · 휴게 — 등록과 수정이 같은 규칙을 쓴다. 시각은 한국 시각 */
export class WorkScheduleFieldsDto {
  /** 근무일 YYYY-MM-DD. 지난 날짜도 받는다 */
  @IsDateOnly(DATE_MESSAGE)
  workDate: string;

  /** 시작 HH:mm, 30분 단위 */
  @Matches(START_TIME_PATTERN, {
    message: '시작은 30분 단위 HH:mm 입니다(00분 · 30분).',
  })
  startTime: string;

  /** 종료 HH:mm, 30분 단위(24:00 까지). 시작보다 이르면 다음 날이다(자정 넘김) */
  @Matches(END_TIME_PATTERN, {
    message: '종료는 30분 단위 HH:mm 입니다(00분 · 30분, 24:00 까지).',
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

/** 직원 앱 월 달력(#205) — 내 소속 하나의 한 달 */
export class MyWorkSchedulesQueryDto {
  /** 내 소속(직원 레코드) — `GET /me/memberships` 의 staffMemberId */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  /** 달 YYYY-MM. 근무일(시작 일시의 한국 날짜)이 그 달인 근무스케줄 */
  // 해 첫 자리 0 은 받지 않는다 — Date.UTC 가 0~99 년을 1900 년대로 읽는다
  @Matches(/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/, {
    message: '달은 YYYY-MM 형식입니다.',
  })
  month: string;
}

export class MyWorkScheduleListResponseDto {
  /** 시작 일시순 */
  items: WorkScheduleDto[];
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

/** 일괄 등록의 직원 한 줄 — 시각은 근무일 기준 한국 시각, 규칙은 한 건 등록과 같다 */
export class BulkWorkScheduleRowDto {
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId: number;

  @Matches(START_TIME_PATTERN, {
    message: '시작은 30분 단위 HH:mm 입니다(00분 · 30분).',
  })
  startTime: string;

  @Matches(END_TIME_PATTERN, {
    message: '종료는 30분 단위 HH:mm 입니다(00분 · 30분, 24:00 까지).',
  })
  endTime: string;

  @IsInt()
  @Min(0)
  @Max(24 * 60)
  breakMinutes: number;
}

/**
 * 여러 직원 일괄 등록(#199). 근무일 하나에 직원별 줄. 화면이 줄마다 계약 값으로 미리 채워 보내고 서버는 받은 값을 그대로
 * 저장한다. 줄 형식이 틀리면 요청 전체가 400 이고, 업무 규칙(계약 · 가입 · 퇴직일 · 겹침 · 범위)에 걸린 줄만 실패로 돌려준다.
 */
export class BulkCreateWorkSchedulesDto {
  /** 근무일 YYYY-MM-DD */
  @IsDateOnly(DATE_MESSAGE)
  workDate: string;

  /** 직원별 줄. 1~100줄. 같은 직원이 여러 줄이면 쪼갠 근무다 */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkWorkScheduleRowDto)
  rows: BulkWorkScheduleRowDto[];
}

/**
 * 일괄 등록에서 저장하지 못한 줄. 업무 규칙(계약 · 가입 · 퇴직일 · 겹침 · 범위)뿐 아니라 시작과 종료가 같은 줄(24시간) ·
 * 휴게가 근무 길이 이상인 줄도 그 줄만 실패이고 code 는 null 이다(형식 오류가 아니라 요청 전체를 막지 않는다).
 */
export class BulkWorkScheduleFailureDto {
  /** 요청 rows 의 순번(0부터) */
  index: number;
  staffMemberId: number;
  /** 한 건 등록이면 받았을 HTTP 상태 — 400 · 404 · 409, 예상 못 한 저장 오류는 500(code WORK_SCHEDULE_SAVE_FAILED) */
  statusCode: number;
  /** WORK_SCHEDULE_NO_CONTRACT · WORK_SCHEDULE_NOT_JOINED · WORK_SCHEDULE_AFTER_RETIREMENT · WORK_SCHEDULE_OVERLAP 등. 없으면 null */
  code: string | null;
  message: string;
}

export class BulkCreateWorkSchedulesResponseDto {
  /** 저장한 근무스케줄(요청 순서) */
  created: WorkScheduleDto[];
  failed: BulkWorkScheduleFailureDto[];
}

export class CopyLastWeekQueryDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId: number;

  /** 복사해 넣을 주의 월요일 YYYY-MM-DD. 원본은 그 직전 주(월~일)다 */
  @IsDateOnly(DATE_MESSAGE)
  weekStart: string;
}

export class CopyLastWeekDto extends CopyLastWeekQueryDto {}

/** 일수와 근무 분(휴게를 뺀 것) */
export class WorkScheduleTotalsDto {
  days: number;
  minutes: number;
}

/** 복사하지 않는(않은) 근무일 하나 */
export class CopyExclusionDto {
  /** 넣을 주의 근무일 YYYY-MM-DD */
  workDate: string;
  /** WORK_SCHEDULE_NO_CONTRACT · WORK_SCHEDULE_AFTER_RETIREMENT · WORK_SCHEDULE_NOT_JOINED · WORK_SCHEDULE_OVERLAP 등 */
  code: string | null;
}

/**
 * 지난 주에 근무스케줄이 있던 직원 한 줄. 본사 계정은 원본 주에 가려진 직원이 있으면 복사 · 미리보기가 409
 * WORK_SCHEDULE_COPY_HIDDEN_STAFF 라 가린 줄은 없다
 */
export class CopyLastWeekStaffDto {
  staffMemberId: number;
  name: string;
  /** 퇴직일(정해졌으면) — 「제외 · 08-20 퇴직」 표시용 */
  retiredDate: string | null;
  /** 지난 주 */
  source: WorkScheduleTotalsDto;
  /** 이번 주에 복사하는(한) 것 */
  copied: WorkScheduleTotalsDto;
  excluded: CopyExclusionDto[];
}

/** 이번 주에 받을 수 있지만 지난 주에 근무스케줄이 없는 직원 — 「지난 주 없음 · 따로 넣는다」 */
export class CopyLastWeekNewcomerDto {
  staffMemberId: number;
  name: string;
}

export class CopyLastWeekResponseDto {
  storeId: number;
  /** 원본 주의 월요일 */
  sourceWeekStart: string;
  weekStart: string;
  staff: CopyLastWeekStaffDto[];
  newcomers: CopyLastWeekNewcomerDto[];
}

export const HISTORY_PAGE_SIZES = [20, 50, 100] as const;

/** 변경 이력 조회(#608) */
export class ListWorkScheduleHistoriesQueryDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  storeId: number;

  /** 변경 일시의 한국 날짜 YYYY-MM-DD 부터(포함) */
  @IsOptional()
  @IsDateOnly(DATE_MESSAGE)
  from?: string;

  /** 변경 일시의 한국 날짜 YYYY-MM-DD 까지(포함) */
  @IsOptional()
  @IsDateOnly(DATE_MESSAGE)
  to?: string;

  /** 직원 레코드로 거른다. 그 점포 직원이 아니거나 본사에게 가려진 직원이면 404 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ID)
  staffMemberId?: number;

  /** 페이지, 1부터. 상한은 OFFSET 이 DB 정수 범위를 넘어 500 이 되지 않게 둔다 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 페이지당 건수 — 20 · 50 · 100, 기본 20 */
  @ApiPropertyOptional({ enum: HISTORY_PAGE_SIZES, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(HISTORY_PAGE_SIZES)
  pageSize?: number;
}

/** 이력 한쪽의 값 — 근무일은 시작 일시의 한국 날짜, 시각은 한국 시각(종료가 시작보다 이르면 다음 날) */
export class WorkScheduleHistoryValueDto {
  workDate: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

export class WorkScheduleHistoryActorDto {
  adminAccountId: number;
  /** 관리자 이름. 이름 칸이 비었거나 계정을 찾지 못하면 null */
  name: string | null;
}

export class WorkScheduleHistoryItemDto {
  workScheduleHistoryId: number;
  workScheduleId: number;
  @ApiProperty({
    enum: WorkScheduleChangeType,
    enumName: 'WorkScheduleChangeType',
  })
  changeType: WorkScheduleChangeType;
  changedAt: string;
  /** 변경 주체. 퇴직 처리가 지운 것은 그 퇴직을 처리한 관리자다 */
  changedBy: WorkScheduleHistoryActorDto;
  staffMemberId: number;
  staffName: string;
  /** 변경 전 — 등록이면 null */
  before: WorkScheduleHistoryValueDto | null;
  /** 변경 후 — 삭제면 null */
  after: WorkScheduleHistoryValueDto | null;
}

export class WorkScheduleHistoryListResponseDto {
  items: WorkScheduleHistoryItemDto[];
  /** 필터를 건 건수(페이지 수 계산용). 본사에게 가려진 직원의 이력은 세지 않는다 */
  total: number;
}
