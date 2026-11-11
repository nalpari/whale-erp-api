import { ApiProperty } from '@nestjs/swagger';
import { AttachmentFileType, FacilityDocumentKind } from '@prisma/client';
import { FACILITY_GROUPS, type FacilityGroup } from '../facility-format';

/** 목록 한 줄 */
export class FacilityListItemDto {
  facilityId: number;
  storeId: number;
  storeCode: string;
  storeName: string;
  /** 점포가 폐점인가 — 목록의 「폐점」 배지. 폐점 점포의 시설물·장비는 조회만 된다 */
  isStoreClosed: boolean;
  /** 운영상태 코드 — 공통코드 FACILITY_STATUS */
  facilityStatusCode: string;
  /** 운영상태 한글 — 운영 · 보관 · 폐기 */
  facilityStatusLabel: string;
  /** 그룹 — STORE_FACILITY(점포 시설물) · STORE_EQUIPMENT(점포 장비) */
  @ApiProperty({ enum: FACILITY_GROUPS, enumName: 'FacilityGroup' })
  facilityGroupCode: FacilityGroup;
  /** 그룹 한글 — 공통코드 그룹명(점포 시설물 · 점포 장비) */
  facilityGroupLabel: string;
  facilityCategoryCode: string;
  /** 분류 한글 — 점포 BP 의 이름. 미사용 분류도 이름이 그대로 보인다 */
  facilityCategoryLabel: string;
  name: string;
  createdAt: Date;
}

export class FacilityListResponseDto {
  items: FacilityListItemDto[];
  total: number;
}

export class FacilityStoreDto {
  storeId: number;
  storeCode: string;
  name: string;
  isClosed: boolean;
}

export class FacilityManagerDto {
  staffMemberId: number;
  /** 이름 — 본사 역할(BM · BA)에게 가맹 점포의 본사 제공 미동의 직원이면 null(ATT-30 가림) */
  name: string | null;
}

export class FacilityDocumentDto {
  facilityDocumentId: number;
  @ApiProperty({ enum: FacilityDocumentKind, enumName: 'FacilityDocumentKind' })
  documentKind: FacilityDocumentKind;
  fileName: string;
  @ApiProperty({ enum: AttachmentFileType, enumName: 'AttachmentFileType' })
  fileType: AttachmentFileType;
  sizeBytes: number;
  /** 내려받기 주소 — 5분 동안 쓸 수 있다. 저장소가 없거나 서명에 실패하면 null */
  downloadUrl: string | null;
  /** 썸네일 주소(긴 변 320px JPEG, 5분 동안 유효) — 그림(JPG · PNG)만, PDF 면 null. 저장소가 없거나 서명에 실패해도 null */
  thumbnailUrl: string | null;
}

/** 상세 — 저장된 값 그대로(비어 있으면 null). 화면은 값이 있는 항목만 보인다 */
export class FacilityDetailResponseDto {
  facilityId: number;
  store: FacilityStoreDto;
  name: string;
  facilityStatusCode: string;
  facilityStatusLabel: string;
  /** 운영상태가 지금 사용 중인가 — false 면 수정 화면이 지금 값을 「(미사용)」으로 둔다(다른 값으로 바꾸면 되돌릴 수 없다) */
  isFacilityStatusActive: boolean;
  /** 그룹 — STORE_FACILITY(점포 시설물) · STORE_EQUIPMENT(점포 장비) */
  @ApiProperty({ enum: FACILITY_GROUPS, enumName: 'FacilityGroup' })
  facilityGroupCode: FacilityGroup;
  facilityGroupLabel: string;
  facilityCategoryCode: string;
  facilityCategoryLabel: string;
  /** 분류가 지금 사용 중인가 — false 면 수정 화면이 「(미사용)」으로 지금 값을 둔다(다른 값으로 바꾸면 되돌릴 수 없다) */
  isFacilityCategoryActive: boolean;
  memo: string | null;
  brand: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  installationLocation: string | null;
  vendorName: string | null;
  vendorPhone: string | null;
  salesRepresentativeName: string | null;
  salesRepresentativePhone: string | null;
  unitPriceAmount: number | null;
  quantity: number;
  /** 단가 × 수량 — 단가가 없으면 null */
  totalAmount: number | null;
  isVatIncluded: boolean;
  /** YYYY-MM-DD */
  purchaseDate: string | null;
  installationDate: string | null;
  usageExpiryDate: string | null;
  warrantyExpiryDate: string | null;
  /** 관리 담당자 — 고른 직원. 그 뒤 퇴직했어도 그대로 보인다 */
  manager: FacilityManagerDto | null;
  /** 관리 담당자 전화번호 — 담당자가 가려졌으면(isManagerHidden) null. 그대로 두고 수정하면 서버가 저장된 번호를 지킨다 */
  managerPhone: string | null;
  /** 관리 담당자가 본사 가림(ATT-30)으로 가려졌는가 — 화면은 이름 · 번호 대신 가림 표시를 한다 */
  isManagerHidden: boolean;
  inspectionCycleCode: string | null;
  inspectionCycleLabel: string | null;
  /** 점검 주기가 지금 사용 중인가 — 분류와 같이 다룬다. 점검 주기가 없으면 null */
  isInspectionCycleActive: boolean | null;
  inspectionNote: string | null;
  serviceCenterZipCode: string | null;
  serviceCenterAddress: string | null;
  serviceCenterAddressDetail: string | null;
  serviceCenterPhone: string | null;
  /** 문서 — 종류 순(사용 매뉴얼 · 주의사항 · 제품 보증서), 올린 것만 */
  documents: FacilityDocumentDto[];
  createdAt: Date;
  createdByName: string | null;
  /** 수정 때 그대로 돌려보낸다 */
  updatedAt: Date;
  /** 최종수정자 — 등록 뒤 고친 적이 없으면 null */
  updatedByName: string | null;
}

export class CreateFacilityResponseDto {
  facilityId: number;
}

export class UpdateFacilityResponseDto {
  facilityId: number;
  updatedAt: Date;
}

export class FacilityStoreOptionDto {
  storeId: number;
  storeCode: string;
  name: string;
  /** 점포 상태 — 미운영 NOT_OPERATING · 운영 OPERATING · 폐점 CLOSED */
  storeStatusCode: string;
}

export class FacilityStoreOptionListResponseDto {
  items: FacilityStoreOptionDto[];
}

export class FacilityManagerOptionDto {
  staffMemberId: number;
  name: string;
  /** 휴대폰 번호 — 숫자만. 화면이 관리 담당자 전화번호 세 칸에 나눠 채운다 */
  phone: string;
}

export class FacilityManagerOptionListResponseDto {
  items: FacilityManagerOptionDto[];
}
