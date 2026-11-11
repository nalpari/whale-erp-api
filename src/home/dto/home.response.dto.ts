import { ApiProperty } from '@nestjs/swagger';

/** 재직 직원 — 퇴직 처리되지 않았고 작성 중 말고 다른 근로계약이 있는 직원 레코드(운영 정책 HOM-02 · CTR-29) */
export class HomeStaffCardDto {
  /** 총수 — 본사 역할에게도 가림 없이 센다(점포별 숫자, 운영 정책 ATT-30) */
  total: number;
  /** 정직원. 본사 역할에게 가려지는 점포(직영이 아닌 점포)는 본사 제공 동의한 직원만 — 그래서 정직원 + 파트타이머가 총수보다 작을 수 있다 */
  fullTime: number;
  /** 파트타이머. 정직원과 같은 기준 */
  partTime: number;
}

/** 운영 점포 — 업무 범위 안 운영 상태 점포(운영 정책 HOM-10). 다른 카드 · 표도 이 점포들만 센다 */
export class HomeStoreCardDto {
  total: number;
  direct: number;
  franchise: number;
  /** 업무 범위 안 미운영 점포 수 — 카드 · 표에는 세지 않고 아랫줄에만 적는다(폐점은 넣지 않는다) */
  notOperating: number;
}

/** 오늘 TO-DO — 수행 날짜가 오늘(한국 날짜)인 TO-DO. 배정 그룹은 한 건이고 그룹의 행이 모두 완료여야 완료다(HOM-10) */
export class HomeTodoCountDto {
  done: number;
  total: number;
}

/** 오늘 출근(한국 날짜) */
export class HomeAttendanceCardDto {
  /** 근무 예정 — 오늘 근무스케줄이 있는 재직 직원 수. 근무스케줄 화면처럼 본사 역할에게도 가림 없이 센다 */
  scheduled: number;
  /** 출근 — 오늘 출근 기록이 있는 직원 수. 본사 역할에게 가려지는 점포(직영이 아닌 점포)는 본사 제공 동의한 직원만(운영 정책 ATT-30 v217) */
  checkedIn: number;
  /**
   * 미출근 — 근무 예정인데 그날 출퇴근 기록이 하나도 없고 첫 근무 시작 시각이 지난 수. 출퇴근 현황의 미출근과 같다(운영 정책
   * ATT-34) — 시작 시각 정각은 아직 예정, 출근 없는 퇴근만 있으면 출근 미등록이라 들지 않는다. 출근과 같은 기준으로 가린다
   */
  notCheckedIn: number;
}

/** 내 문의 — 로그인한 관리자가 쓴 문의사항 */
export class HomeInquiryCardDto {
  /** 답변 대기 — 접수 · 처리중 */
  waiting: number;
  /** 답변완료 */
  answered: number;
}

/** 수치 카드. 그 메뉴의 조회 권한이 없는 카드는 null */
export class HomeCardsDto {
  /** 직원 정보 관리 조회 권한 */
  staff: HomeStaffCardDto | null;
  /** 서명 전 계약(서명 요청 전 + 서명 대기 + 수정 요청). 본사 역할에게 가려지는 점포는 동의한 직원의 계약만. 근로계약 관리 조회 권한 */
  unsignedContractCount: number | null;
  stores: HomeStoreCardDto;
  /** 출퇴근 현황 · 근무스케줄 관리 조회 권한 둘 다 */
  todayAttendance: HomeAttendanceCardDto | null;
  /** 문의사항 조회 권한 */
  myInquiries: HomeInquiryCardDto | null;
  /** 오늘 TO-DO. TO-DO 리스트 관리 조회 권한. 본사 역할에게도 TO-DO 목록처럼 가리지 않고 센다(HOM-10 v278) */
  todayTodo: HomeTodoCountDto | null;
}

/** 점포별 현황 표 한 줄. 권한이 없는 칸은 null(카드와 같은 권한) */
export class HomeStoreRowDto {
  storeId: number;
  storeName: string;
  /** 점포 유형 코드 — DIRECT · FRANCHISE */
  storeTypeCode: string;
  staffCount: number | null;
  unsignedContractCount: number | null;
  /** 오늘 출근 — 카드의 checkedIn 과 같은 기준(본사 역할에게 가려지는 점포는 동의한 직원만) */
  checkedInCount: number | null;
  /** 오늘 근무 예정 — 가림 없이 */
  scheduledCount: number | null;
  /** 미출근 — 카드의 notCheckedIn 과 같은 판정 · 가림 */
  notCheckedInCount: number | null;
  /** 오늘 TO-DO — 카드의 todayTodo 와 같은 기준. 점포별 값을 더하면 카드와 같다 */
  todayTodo: HomeTodoCountDto | null;
  /**
   * 점포별 확인 필요(예전 이름 미조치, 운영 정책 HOM-03) — 계약 갱신 예정 + 직원 서명 대기 + 직원 수정 요청 + 소속 확인 거절 +
   * 긴급 TO-DO(대기 · 진행 중). 볼 수 있는 영역의 건수만 더한다
   */
  pendingActionCount: number;
}

export class HomeStoreTableDto {
  /** 운영 점포 전체 수 */
  total: number;
  /** 운영 점포 모두 — 확인 필요 많은 순, 같으면 점포명(HOM-06) */
  items: HomeStoreRowDto[];
}

export class HomeSummaryResponseDto {
  /** 조회 시각 */
  asOf: Date;
  /** 플랫폼 계정(플랫폼 마스터 · 플랫폼 관리자)이면 true — 현황 없이 안내만 보이고, 나머지 칸은 null · 빈 표다 */
  platform: boolean;
  cards: HomeCardsDto | null;
  storeTable: HomeStoreTableDto;
}

export const HOME_PENDING_TYPES = [
  'CONTRACT_RENEWAL',
  'CONTRACT_PENDING_SIGNATURE',
  'CONTRACT_CORRECTION_REQUESTED',
  'AFFILIATION_REJECTED',
  'INQUIRY_ANSWERED',
  'URGENT_TODO',
] as const;
export type HomePendingType = (typeof HOME_PENDING_TYPES)[number];

/** 확인 필요 항목이 이동할 화면의 조건 */
export class HomePendingFilterDto {
  /** 점포. 문의는 점포로 거르지 않아 빈 배열 */
  storeIds: number[];
  /** 그 화면 목록의 상태 필터 값 — 근로계약 상태 · 가입 상태 · 문의 답변 상태 · TO-DO 상태 */
  status: string[];
}

/** 확인 필요(홈) 한 유형 — 출퇴근 기록 꼬리표 「확인 필요」와 다른 뜻이다 */
export class HomePendingItemDto {
  /**
   * 계약 갱신 예정(종료 30일 안) · 직원 서명 대기 · 직원 수정 요청 · 소속 확인 거절 · 문의 답변완료(마지막 답변이 최근 7일 안) · 긴급 TO-DO(대기 · 진행 중)
   */
  @ApiProperty({ enum: HOME_PENDING_TYPES, enumName: 'HomePendingType' })
  type: HomePendingType;
  count: number;
  /** 대표 이름 — 가장 오래 기다린 것의 직원 이름(문의 · TO-DO 는 제목). 가려지는 직원이면 null */
  firstName: string | null;
  isFirstNameMasked: boolean;
  /** 대표 말고 나머지 건수(「외 N명」) */
  othersCount: number;
  /** 가장 오래 기다린 일수(한국 날짜) — 서명 대기는 발송 뒤, 수정 요청은 요청 뒤, 소속 확인 거절은 거절 뒤, 문의는 마지막 답변 뒤, TO-DO 는 등록 뒤. 갱신 예정은 null */
  waitingDays: number | null;
  /** 계약 갱신 예정만 — 종료가 가장 이른 계약의 종료까지 남은 날(한국 날짜, D-N). 다른 유형은 null */
  dueInDays: number | null;
  filter: HomePendingFilterDto;
}

export class HomePendingResponseDto {
  asOf: Date;
  /** 플랫폼 계정이면 true — items 는 빈 배열 */
  platform: boolean;
  /** 건수가 0인 유형과 권한이 없는 유형은 뺀다. 순서는 갱신 예정 → 계약 → 직원 → 문의 → TO-DO */
  items: HomePendingItemDto[];
}
