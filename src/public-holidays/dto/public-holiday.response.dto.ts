/** 공식 휴일 하루. 한 날짜에 한 건이라, 겹친 휴일은 이름이 이어 붙어 있다(예 `어린이날 · 부처님오신날`). */
export class PublicHolidayResponseDto {
  publicHolidayId: number;
  /** 날짜. @example 2026-03-02 */
  holidayDate: string;
  /** 휴일명. @example 삼일절 */
  name: string;
  /** 비고. 없으면 null(대체공휴일이면 그 사유). @example 대체공휴일 — 삼일절 */
  note: string | null;
}

/** 공식 휴일 동기화 상태 — 화면의 「최종 동기화」와 실패 안내용. */
export class PublicHolidaySynchronizationResponseDto {
  /** 성공한 마지막 동기화 시각(ISO 8601). 동기화한 적이 없으면 null. @example 2026-09-01T03:00:00.000Z */
  lastSynchronizedAt: string | null;
  /** 올해 · 다음 해(한국 날짜 기준) 중 마지막 동기화가 실패한 연도. 없으면 빈 배열. @example [2027] */
  failedYears: number[];
}

/** 공식 휴일 조회 — 날짜순, 페이지 없이. */
export class PublicHolidayListResponseDto {
  /** 고른 연도. */
  year: number;
  /** 고른 월. 연도 전체를 조회했으면 null. */
  month: number | null;
  items: PublicHolidayResponseDto[];
  /** 공식 휴일 수(고른 달, 또는 그 해). */
  total: number;
  synchronization: PublicHolidaySynchronizationResponseDto;
}
