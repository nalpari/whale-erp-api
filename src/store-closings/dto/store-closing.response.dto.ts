import type { StoreClosingRetirementResult } from '../../staff-members/retirement.service';
import type {
  StoreClosingCounts,
  StoreClosingOpenCheckIn,
} from '../../staff-members/store-closing-check';

// 3팀 결과 타입을 implements 한다 — 3팀이 칸을 더하거나 바꾸면 여기서 컴파일이 깨져, 응답에는 나가는데 Swagger · 생성 타입에서
// 빠지는 칸이 생기지 않는다.

/** 폐점을 막는 퇴근하지 않은 출근 가운데 이름을 내보내는 첫 건 */
export class StoreClosingOpenCheckInDto implements StoreClosingOpenCheckIn {
  /** 그 출근의 점포 */
  storeId: number;
  attendanceRecordId: number;
  staffMemberId: number;
  /** 직원 이름 */
  name: string;
  /** 출근 시각 */
  recordedAt: Date;
  /** 출근한 다음 날이 지나 직원 앱으로는 퇴근할 수 없다 — 출퇴근 현황에서 관리자 보정으로 닫는다 */
  isCheckOutExpired: boolean;
}

/** 퇴근하지 않은 출근(재직 직원, 보정할 수 있는 3개월 안) */
export class StoreClosingOpenCheckInsDto {
  /** 이름을 내보내는 열린 출근 수 */
  count: number;
  /** 본사 역할에게 가려지는 직원(본사 제공 동의를 하지 않은 가맹 직원 등)의 열린 출근 수 — 이름 없이 수만 */
  hiddenCount: number;
  /** 이름을 내보내는 것 가운데 출근 시각이 가장 이른 것. 없으면 null */
  first: StoreClosingOpenCheckInDto | null;
}

/**
 * 폐점 확인 수 — 점포별 · 합계에 같이 쓴다. 폐점하면 그 점포 직원에게 발송한 초대도 모두 만료된다(수는 확인에 없고 결과의
 * expiredInvitations 로 나온다).
 */
export class StoreClosingCountsDto implements StoreClosingCounts {
  openCheckIns: StoreClosingOpenCheckInsDto;
  /**
   * 폐점하면 퇴직될 직원 수 — 퇴직일이 없거나 폐점일보다 뒤면 폐점일(한국 날짜 오늘)로 정하고, 이미 그 이전이면 그대로 둔다.
   * 임시저장 계약만 있는 가입 전 레코드는 세지 않는다(그 임시저장은 draftContracts 로 드러난다)
   */
  retiringStaff: number;
  /** 폐점하면 종료될 임시저장 계약 수 */
  draftContracts: number;
  /** 폐점하면 종료될 발송 대기 계약 수 */
  pendingSendContracts: number;
  /** 폐점하면 종료될 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 확정하지 않은(작성 중 · 검토 중) 급여명세서 수 — 폐점 뒤에도 처리할 수 있다 */
  unconfirmedPayslips: number;
  /** 폐점할 수 없다 — 퇴근하지 않은 출근이 있다(openCheckIns.count + hiddenCount > 0). 합계의 값은 응답 최상위 isBlocked 와 같다 */
  isBlocked: boolean;
}

export class StoreClosingStoreCheckDto extends StoreClosingCountsDto {
  storeId: number;
  /** 점포명 */
  storeName: string;
  /** 점포코드 */
  storeCode: string;
}

/** 폐점 확인 — 점포 폐점 · 회원 탈퇴 · BP 탈퇴가 같이 쓴다 */
export class StoreClosingCheckResponseDto {
  /** 점포별 결과 — 점포 id 오름차순 */
  stores: StoreClosingStoreCheckDto[];
  /** 같은 칸의 합계 */
  total: StoreClosingCountsDto;
  /** 하나라도 막히면 true — total.isBlocked 와 같은 값(편의용) */
  isBlocked: boolean;
}

/** 폐점하면서 처리한 수 */
export class StoreClosingRetirementDto implements StoreClosingRetirementResult {
  /**
   * 퇴직될 직원 수 — 확인의 retiringStaff 와 같은 기준(퇴직일이 없거나 폐점일보다 뒤면 폐점일로 정함, 이미 그 이전이면 그대로,
   * 임시저장 계약만 있는 가입 전 레코드는 세지 않음)
   */
  retiringStaff: number;
  /**
   * 퇴직일을 폐점일로 당긴 직원 수. 늘 retiringStaff 안에 드는 것은 아니다 — 세지 않는 가입 전 레코드의 당김도 들어간다
   */
  pulledForwardStaff: number;
  /** 종료로 닫은 임시저장 계약 수 */
  draftContracts: number;
  /** 종료로 닫은 발송 대기 계약 수 */
  pendingSendContracts: number;
  /** 종료로 닫은 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 만료로 바꾼 초대 수 — 그 점포 직원에게 발송한(SENT) 초대 전부 */
  expiredInvitations: number;
}

export class StoreClosingStoreResultDto extends StoreClosingRetirementDto {
  storeId: number;
  /** 점포명 */
  storeName: string;
  /** 점포코드 */
  storeCode: string;
}

/** 폐점 결과 — 점포 폐점 · 회원 탈퇴 · BP 탈퇴가 같이 쓴다 */
export class StoreClosingResultResponseDto {
  /** 점포별 결과 — 점포 id 오름차순 */
  stores: StoreClosingStoreResultDto[];
  /** 같은 칸의 합계 */
  total: StoreClosingRetirementDto;
}
