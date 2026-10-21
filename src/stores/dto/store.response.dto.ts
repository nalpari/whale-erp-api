import { ApiProperty } from '@nestjs/swagger';
import { StoreImageFileType } from '@prisma/client';
import {
  BUSINESS_VERIFICATION_RESULTS,
  type BusinessVerificationResult,
  FLOOR_TYPES,
  OPERATION_REQUIREMENTS,
  type OperationRequirement,
  STORE_STATUSES,
  STORE_TYPES,
} from '../store-format';

/** 점포 정보 관리 목록 한 줄 */
export class StoreSummaryResponseDto {
  storeId: number;
  /** 점포코드. @example ST000001 */
  storeCode: string;
  /** 점포명 */
  name: string;
  @ApiProperty({ enum: STORE_TYPES })
  storeTypeCode: string;
  @ApiProperty({ enum: STORE_STATUSES })
  storeStatusCode: string;
  /** 소속 BP */
  bpCodeId: number;
  /** 소속 BP 상호명 — 플랫폼 계정이 여러 BP 를 함께 볼 때 쓴다 */
  bpTradeName: string;
  /** 사업자등록번호(숫자 10자리). 없으면 미인증 — 화면은 「-」와 「사업자정보 미인증」. */
  bizRegistrationNumber: string | null;
  /** 점포 연락처 */
  phone: string | null;
  /** 지역 — 기본주소의 앞 두 마디. @example 서울특별시 서초구 */
  region: string | null;
  /** 재직 직원 수 — 이 점포가 근무지이고 퇴직하지 않았으며 지금 체결 완료 근로계약이 있는 직원 레코드. 체결 완료 계약이 없는 레코드(초안 · 발송 대기 · 서명 대기 · 수정 요청 · 거부 · 만료 · 종료뿐)는 세지 않는다. 퇴직 예정은 퇴직일까지 센다 */
  staffCount: number;
  /** 대표 이미지 썸네일 주소(5분 동안 유효). 이미지가 없거나 저장소를 쓸 수 없으면 null — 화면은 점포 아이콘. */
  imageUrl: string | null;
  /** 등록일시 */
  createdAt: Date;
}

export class StoreListResponseDto {
  items: StoreSummaryResponseDto[];
  total: number;
}

export class StoreFloorResponseDto {
  storeFloorId: number;
  @ApiProperty({ enum: FLOOR_TYPES, nullable: true })
  floorTypeCode: string | null;
  floorNumber: number | null;
  floorAreaPyeong: number | null;
  floorAreaSqm: number | null;
  seatCount: number | null;
}

/** 점포 대표 이미지 */
export class StoreImageResponseDto {
  fileId: number;
  /** 올린 원래 파일 이름 */
  fileName: string;
  @ApiProperty({ enum: StoreImageFileType, enumName: 'StoreImageFileType' })
  fileType: StoreImageFileType;
  sizeBytes: number;
  /** 보여 줄 주소(서명, 5분 동안 유효). 저장소를 쓸 수 없으면 null. */
  url: string | null;
}

/** 점포 사업자정보 */
export class StoreBusinessResponseDto {
  /** 인증 완료 — 사업자등록번호가 있으면 인증된 것이다 */
  isVerified: boolean;
  bizRegistrationNumber: string | null;
  ceoName: string | null;
  /** 개업일자 YYYY-MM-DD */
  openDate: string | null;
  /** 최종 인증일시 */
  verifiedAt: Date | null;
  tradeName: string | null;
  ceoPhone: string | null;
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
  category: string | null;
  item: string | null;
}

/** 상태 전환 · 삭제를 지금 할 수 있는가. 상세의 버튼과 수정 화면의 폐점 선택이 쓴다. */
export class StoreTransitionCheckResponseDto {
  /** 운영으로 바꾸는 데 모자란 것. 비어 있으면 운영할 수 있다. 한글은 GET /enums/StoreOperationRequirement. */
  @ApiProperty({
    enum: OPERATION_REQUIREMENTS,
    enumName: 'StoreOperationRequirement',
    isArray: true,
  })
  missingForOperation: OperationRequirement[];
  /** 진행 중인 근로계약 수 — 거부 · 만료 · 종료되지 않은 계약. 0 이어야 폐점 · 삭제된다. */
  inProgressContractCount: number;
  /** 폐점할 수 있는가 */
  canClose: boolean;
  /** 삭제할 수 있는가 — 미운영이면서 폐점 조건을 채울 때 */
  canDelete: boolean;
  /** 구독 · 정산 조건은 1차 범위 밖이라 보지 않는다 — 화면은 「1차 범위 밖」으로 보인다 */
  isSubscriptionChecked: boolean;
}

export class StoreDetailResponseDto {
  storeId: number;
  storeCode: string;
  name: string;
  @ApiProperty({ enum: STORE_TYPES })
  storeTypeCode: string;
  @ApiProperty({ enum: STORE_STATUSES })
  storeStatusCode: string;
  /** 폐점일 YYYY-MM-DD. 폐점이 아니면 null. */
  closedDate: string | null;
  bpCodeId: number;
  /** 소속 BP 코드. @example BP000001 */
  bpCode: string;
  bpTradeName: string;
  /** 소속 BP 상태 — ACTIVE 가 아니면 조회만 된다(STORE-3) */
  bpAccountStatusCode: string;
  phone: string | null;
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
  latitude: number | null;
  longitude: number | null;
  isLocationApplied: boolean;
  /** 재직 직원 수 — 목록의 staffCount 와 같은 기준 */
  staffCount: number;
  business: StoreBusinessResponseDto;
  /** 대표 이미지. 없으면 null. */
  image: StoreImageResponseDto | null;
  floors: StoreFloorResponseDto[];
  transitions: StoreTransitionCheckResponseDto;
  createdAt: Date;
  /** 등록자 이름. 시스템이 만들었으면 null. */
  createdByName: string | null;
  /** 최종수정일시. 수정할 때 그대로 돌려보낸다(동시 수정 확인). */
  updatedAt: Date;
  /** 최종수정자 이름. 등록 뒤 고친 적이 없으면 null — 화면은 「-」. */
  updatedByName: string | null;
}

export class StoreHistoryResponseDto {
  changeId: number;
  /** 변경 항목. @example 점포 연락처 */
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  changedAt: Date;
  /** 변경자 이름. 시스템이 처리했으면 null. */
  changedByName: string | null;
}

export class StoreHistoryListResponseDto {
  items: StoreHistoryResponseDto[];
  total: number;
}

export class CreateStoreResponseDto {
  storeId: number;
  storeCode: string;
}

/** 저장 전 사업자 인증 결과 */
export class StoreBusinessVerificationResponseDto {
  /** 인증됨 · 확인 불가(국세청 정보와 다름) · 번호 중복(미운영 · 운영 점포가 쓰는 번호 — 누가 쓰는지는 알리지 않는다) */
  @ApiProperty({
    enum: BUSINESS_VERIFICATION_RESULTS,
    enumName: 'StoreBusinessVerificationResult',
  })
  result: BusinessVerificationResult;
}
