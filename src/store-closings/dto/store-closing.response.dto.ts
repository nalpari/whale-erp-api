/** 폐점을 막는 퇴근하지 않은 출근 가운데 이름을 내보내는 첫 건 */
export class StoreClosingOpenCheckInDto {
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

/** 폐점 확인 수 — 점포별 · 합계에 같이 쓴다 */
export class StoreClosingCountsDto {
  openCheckIns: StoreClosingOpenCheckInsDto;
  /** 폐점하면 퇴직될 직원 수(퇴직일 오늘) */
  retiringStaff: number;
  /** 폐점하면 종료될 임시저장 계약 수 */
  draftContracts: number;
  /** 폐점하면 종료될 발송 대기 계약 수(초대도 무효) */
  pendingSendContracts: number;
  /** 폐점하면 종료될 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 확정하지 않은(작성 중 · 검토 중) 급여명세서 수 — 폐점 뒤에도 처리할 수 있다 */
  unconfirmedPayslips: number;
  /** 폐점할 수 없다 — 퇴근하지 않은 출근이 있다(openCheckIns.count + hiddenCount > 0) */
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
  /** 하나라도 막히면 true — total.isBlocked 와 같다 */
  isBlocked: boolean;
}

/** 폐점하면서 처리한 수 */
export class StoreClosingRetirementDto {
  /** 퇴직될 직원 수(퇴직일 = 폐점일) */
  retiringStaff: number;
  /** 퇴직일을 폐점일로 당긴 직원 수 */
  pulledForwardStaff: number;
  /** 종료로 닫은 임시저장 계약 수 */
  draftContracts: number;
  /** 종료로 닫은 발송 대기 계약 수 */
  pendingSendContracts: number;
  /** 종료로 닫은 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 만료로 바꾼 초대 수 */
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
