import { IsOptional } from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';

export class StaffMemberWeekQueryDto {
  /** 볼 주의 아무 날짜(YYYY-MM-DD). 그 주 월요일로 맞춘다. 빼면 이번 주(한국 날짜) */
  @IsOptional()
  @IsDateOnly('weekStart 는 YYYY-MM-DD 형식의 있는 날짜입니다')
  weekStart?: string;
}
