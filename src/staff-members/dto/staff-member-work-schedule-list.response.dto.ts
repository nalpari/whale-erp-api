export class StaffMemberWorkScheduleListItemDto {
  workScheduleId: number;
  /** 근무일(YYYY-MM-DD) — 시작 일시의 한국 날짜 */
  workDate: string;
  /** 근무지 점포 이름 */
  storeName: string;
  /** 시작 HH:mm(한국 시각) */
  startTime: string;
  /** 종료 HH:mm(한국 시각). 시작보다 이르면 다음 날이다 */
  endTime: string;
}

export class StaffMemberWorkScheduleListResponseDto {
  /** 근무일 내림차순 → 같은 날은 시작 시각 오름차순 → 근무스케줄 ID */
  items: StaffMemberWorkScheduleListItemDto[];
  /** 기간 안의 지우지 않은 근무스케줄 수(모든 페이지) */
  total: number;
  /** 기간 안의 근무시간 합계(분, 페이지와 무관) — 건마다 종료 − 시작 − 휴게(직원 상세 요약의 workMinutes 와 같다). 0건이면 0 */
  totalWorkMinutes: number;
}
