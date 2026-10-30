/** 최저임금 한 시행일 — 공통코드 MINIMUM_WAGE 한 행(WHALEERP-595) */
export class MinimumWageDto {
  /** 시행일 YYYY-MM-DD — 이날부터 적용 */
  effectiveDate: string;
  /** 시급(원) */
  hourlyWage: number;
}

/** 사용 중인 최저임금 전부, 시행일 오름차순. 계약 시작일에는 시행일이 그날 이전인 것 중 가장 늦은 값을 쓴다 */
export class MinimumWagesResponseDto {
  items: MinimumWageDto[];
}
