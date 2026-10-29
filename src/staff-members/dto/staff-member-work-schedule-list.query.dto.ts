import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 직원 상세 근무스케줄 표의 기간(WHALEERP-185). 이번 주는 한국 날짜 기준 이번 주 월~일, 나머지는 오늘(한국 날짜)에서 그만큼
 * 전부터 상한 없이 — 미래에 잡힌 근무까지 든다. 전체는 조건이 없다(생성일로부터 3년 지난 것은 파기 배치가 지운다).
 */
export const STAFF_WORK_SCHEDULE_PERIODS = [
  'THIS_WEEK',
  'LAST_4_WEEKS',
  'LAST_3_MONTHS',
  'LAST_1_YEAR',
  'ALL',
] as const;
export type StaffWorkSchedulePeriod =
  (typeof STAFF_WORK_SCHEDULE_PERIODS)[number];

/** 페이지당 건수 — 급여명세서 목록 · 근무스케줄 변경 이력과 같다 */
export const STAFF_WORK_SCHEDULE_PAGE_SIZES = [20, 50, 100] as const;

export class StaffMemberWorkScheduleListQueryDto {
  /**
   * 기간. 빼면 이번 주. 근무일(시작 일시의 한국 날짜)로 자른다.
   * - `THIS_WEEK` — 오늘(한국 날짜)이 든 주의 월~일
   * - `LAST_4_WEEKS` — 오늘에서 28일 전 0시부터, 상한 없음(미래에 잡힌 근무 포함)
   * - `LAST_3_MONTHS` — 오늘에서 3개월 전 같은 날 0시부터, 상한 없음(미래 포함). 그 달에 같은 날이 없으면 그 달 말일(5월 31일 → 2월 28일)
   * - `LAST_1_YEAR` — 오늘에서 12개월 전 같은 날 0시부터, 상한 없음(미래 포함). 말일 보정은 3개월과 같다
   * - `ALL` — 날짜 조건 없음(생성일로부터 3년 지난 것은 파기 배치가 지운다)
   */
  @ApiPropertyOptional({
    enum: STAFF_WORK_SCHEDULE_PERIODS,
    enumName: 'StaffWorkSchedulePeriod',
    default: 'THIS_WEEK',
  })
  @IsOptional()
  @IsIn(STAFF_WORK_SCHEDULE_PERIODS, {
    message: `period 는 ${STAFF_WORK_SCHEDULE_PERIODS.join(' · ')} 중 하나입니다.`,
  })
  period?: StaffWorkSchedulePeriod;

  /** 페이지, 1부터. 상한은 OFFSET 이 DB 정수 범위를 넘어 500 이 되지 않게 둔다 */
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 페이지당 건수 — 20 · 50 · 100, 기본 20 */
  @ApiPropertyOptional({ enum: STAFF_WORK_SCHEDULE_PAGE_SIZES, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(STAFF_WORK_SCHEDULE_PAGE_SIZES)
  pageSize?: number;
}
