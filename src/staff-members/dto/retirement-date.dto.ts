import { ValidateBy } from 'class-validator';
import { parseDateOnly } from '../kst-date';

/**
 * `YYYY-MM-DD` 이고 실제로 있는 날짜인지. 모양 검사와 달력 검사를 한 데코레이터에서 해야 400 응답이
 * 한 모양(ValidationPipe 의 배열 message)이 된다 — 둘을 나누면 2월 30일만 다른 모양으로 나간다.
 */
function IsDateOnly(): PropertyDecorator {
  return ValidateBy({
    name: 'isDateOnly',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && parseDateOnly(value) !== null,
      defaultMessage: () => '퇴직일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다',
    },
  });
}

/** 퇴직 처리 · 퇴직일 변경 · 미리 보기 요청. */
export class RetirementDateDto {
  /**
   * 퇴직일(YYYY-MM-DD, 한국 날짜). 그날까지 재직이고 다음 날 0시에 퇴직이 확정된다. 오늘 이후이거나 최근
   * 3개월 안의 지난 날짜만 받고, 입사일보다 앞설 수 없다.
   * @example 2026-10-31
   */
  @IsDateOnly()
  retiredDate: string;
}
