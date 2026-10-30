/**
 * 공식 휴일이 있는 해 — 2000~2050(2026-10-30 결정). 음력 휴일은 한국천문연구원 음양력 표로 계산했는데 그 표가 2050년까지라
 * 2051년부터는 설날 · 부처님오신날 · 추석을 채울 수 없다. DB CHECK `public_holidays_year_range` 와 같은 범위다.
 */
export const FIRST_PUBLIC_HOLIDAY_YEAR = 2000;
export const LAST_PUBLIC_HOLIDAY_YEAR = 2050;

/** 동기화하는 해 — 한국 날짜의 올해와 다음 해 중 범위 안의 것. */
export const syncYearsOf = (thisYear: number): number[] =>
  [thisYear, thisYear + 1].filter((y) => y <= LAST_PUBLIC_HOLIDAY_YEAR);
