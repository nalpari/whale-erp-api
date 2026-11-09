import type { StoreClosingRetirementResult } from '../../staff-members/retirement.service';
import type { StoreClosingCounts } from '../../staff-members/store-closing-check';

// 3팀 결과 타입을 implements 하고(필수 칸 추가 · 이름 변경 · 좁힘), 파일 끝의 키 집합 단언으로 선택 칸 추가까지 잡는다 — 서비스가
// 3팀 결과를 펼쳐 담으므로, 여기서 빠진 칸은 응답에는 나가는데 Swagger · 생성 타입에는 없게 된다. 칸을 넓히면 서비스의 대입에서 깨진다.
// 예외 하나: 열린 출근의 첫 건(openCheckIns.first — 직원 이름 · 시각)은 일부러 내보내지 않는다(아래 StoreClosingOpenCheckInsDto).

/**
 * 퇴근하지 않은 출근(재직 직원, 보정할 수 있는 3개월 안) — 수만 내보낸다. 3팀 결과에는 첫 건(직원 이름 · 출근 시각)이 있지만,
 * 이 응답은 점포 메뉴 조회 권한만으로 보이고 화면도 건수만 안내하므로 직원 개인정보를 싣지 않는다(2026-11-04). 어느 출근인지는
 * 출퇴근 현황에서 찾는다 — 다만 본사 역할(BM · BA)에게 가려진 직원의 출근은 거기에도 줄로 보이지 않는다(수만 보인다). 저장 때의
 * 409 OPEN_CHECK_IN 문구도 같은 이유로 출근 시각을 싣지 않는다.
 */
export class StoreClosingOpenCheckInsDto {
  /** 본사 역할에게도 이름이 보이는 직원의 열린 출근 수 */
  count: number;
  /** 본사 역할에게 가려지는 직원(본사 제공 동의를 하지 않은 가맹 직원 등)의 열린 출근 수 */
  hiddenCount: number;
}

/**
 * 폐점 확인 수 — 점포별 · 합계에 같이 쓴다. 폐점하면 그 점포 직원에게 발송한 초대도 모두 만료된다(수는 확인에 없고 결과의
 * expiredInvitations 로 나온다).
 */
export class StoreClosingCountsDto implements Omit<
  StoreClosingCounts,
  'openCheckIns'
> {
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

/** 폐점 확인 — 점포 폐점과 회원 탈퇴(조건 조회의 closing)가 쓰고, BP 탈퇴가 같이 쓸 예정이다 */
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

/** 폐점 결과 — 점포 폐점이 응답으로 쓴다. 회원 탈퇴는 close 를 부르지만 204 라 이 결과를 내보내지 않는다. BP 탈퇴가 같이 쓸 예정이다 */
export class StoreClosingResultResponseDto {
  /** 점포별 결과 — 점포 id 오름차순 */
  stores: StoreClosingStoreResultDto[];
  /** 같은 칸의 합계 */
  total: StoreClosingRetirementDto;
}

// 3팀 결과에 있는데 DTO 에 없는 키가 있으면 never 가 아니어서 컴파일이 깨진다(선택 칸 포함 — implements 는 선택 칸 추가를 못 잡는다).
type NoMissingKeys<T extends never> = T;
export type StoreClosingDtoKeyChecks = [
  // first 는 일부러 뺀다 — 그 밖에 3팀이 더한 칸은 여기서 걸린다
  NoMissingKeys<
    Exclude<
      keyof StoreClosingCounts['openCheckIns'],
      keyof StoreClosingOpenCheckInsDto | 'first'
    >
  >,
  NoMissingKeys<Exclude<keyof StoreClosingCounts, keyof StoreClosingCountsDto>>,
  NoMissingKeys<
    Exclude<keyof StoreClosingRetirementResult, keyof StoreClosingRetirementDto>
  >,
];
