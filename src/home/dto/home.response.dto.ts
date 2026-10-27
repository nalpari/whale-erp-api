import { ApiProperty } from '@nestjs/swagger';

/** 재직 직원 — 퇴직 처리되지 않았고 임시저장 말고 다른 근로계약이 있는 직원 레코드(운영 정책 HOM-02 · CTR-29) */
export class HomeStaffCardDto {
  /** 총수 — 본사 역할에게도 가림 없이 센다(점포별 숫자, 운영 정책 ATT-30) */
  total: number;
  /** 정직원. 본사 역할에게 가려지는 점포(직영이 아닌 점포)는 본사 제공 동의한 직원만 — 그래서 정직원 + 파트타이머가 총수보다 작을 수 있다 */
  fullTime: number;
  /** 파트타이머. 정직원과 같은 기준 */
  partTime: number;
}

/** 운영 점포 — 업무 범위 안 폐점이 아닌 점포. 다른 카드 · 표 · 처리 대기도 이 점포들만 센다 */
export class HomeStoreCardDto {
  total: number;
  direct: number;
  franchise: number;
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
  /** 미체결 계약(발송 대기 + 서명 대기 + 수정 요청). 본사 역할에게 가려지는 점포는 동의한 직원의 계약만. 근로계약 관리 조회 권한 */
  unsignedContractCount: number | null;
  stores: HomeStoreCardDto;
  /** 출퇴근 현황 · 근무스케줄 관리 조회 권한 둘 다 */
  todayAttendance: HomeAttendanceCardDto | null;
  /** 문의사항 조회 권한 */
  myInquiries: HomeInquiryCardDto | null;
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
  /** 미조치 — 서명 대기 + 근로계약 수정 요청 + 소속 확인 거절 + 긴급 TO-DO 미완료. 볼 수 있는 영역의 건수만 더한다 */
  pendingActionCount: number;
}

export class HomeStoreTableDto {
  /** 운영 점포 전체 수 */
  total: number;
  /** 미조치 많은 순(같으면 점포명) 일곱 곳 */
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

/** 경고 밴드 — 갱신 예정 계약 중 종료일이 오늘부터 7일 안인 것 */
export class HomeRenewalDto {
  contractId: number;
  /** 가려지는 직원(본사 제공 동의가 없는 가맹 점포 직원)이면 null */
  staffMemberId: number | null;
  /** 가려지는 직원이면 null */
  name: string | null;
  isMasked: boolean;
  storeId: number;
  storeName: string;
  /** 계약 종료일(YYYY-MM-DD) */
  endDate: string;
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

/** 처리 대기 항목이 이동할 화면의 조건 */
export class HomePendingFilterDto {
  /** 점포. 문의는 점포로 거르지 않아 빈 배열 */
  storeIds: number[];
  /** 그 화면 목록의 상태 필터 값 — 근로계약 상태 · 가입 상태 · 문의 답변 상태 · TO-DO 상태 */
  status: string[];
}

/** 처리 대기 한 유형 */
export class HomePendingItemDto {
  /**
   * 계약 갱신 예정 · 근로계약 서명 대기 · 근로계약 수정 요청 · 소속 확인 거절 · 문의 답변완료(마지막 답변이 최근 7일 안) · 긴급 TO-DO 미완료
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
  filter: HomePendingFilterDto;
}

export class HomePendingResponseDto {
  asOf: Date;
  /** 플랫폼 계정이면 true — renewals 는 null, items 는 빈 배열 */
  platform: boolean;
  /** 경고 밴드. 근로계약 관리 조회 권한이 없으면 null */
  renewals: HomeRenewalDto[] | null;
  /** 건수가 0인 유형과 권한이 없는 유형은 뺀다. 순서는 갱신 예정 → 계약 → 직원 → 문의 → TO-DO */
  items: HomePendingItemDto[];
}
