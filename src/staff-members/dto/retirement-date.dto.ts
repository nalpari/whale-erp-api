import { IsDateOnly } from '../../common/is-date-only';

/** 퇴직 처리 · 퇴직일 변경 · 미리 보기 요청. */
export class RetirementDateDto {
  /**
   * 퇴직일(YYYY-MM-DD, 한국 날짜). 그날까지 재직이고 다음 날 0시에 퇴직이 확정된다. 오늘 이후이거나 최근
   * 3개월 안의 지난 날짜만 받고, 입사일보다 앞설 수 없다.
   * @example 2026-10-31
   */
  @IsDateOnly('퇴직일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다.')
  retiredDate: string;
}
