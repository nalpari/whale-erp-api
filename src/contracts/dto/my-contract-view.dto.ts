import { ApiProperty } from '@nestjs/swagger';
import {
  ContractDocumentKind,
  ContractMethod,
  ContractStatus,
  EmploymentType,
  Gender,
} from '@prisma/client';
import { IDENTITY_FIELDS, type IdentityField } from '../identity-match';
import { ContractTermsDto } from './contract.response.dto';

/** 직원 앱 근로계약 목록의 한 줄 (GET /me/contracts, WHALEERP-610) */
export class MyContractListItemDto {
  contractId: number;
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  status: ContractStatus;
  /** 근무지(소속) — 점포가 지워졌어도 이름은 보인다 */
  storeId: number;
  storeName: string;
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  /** 전자계약 · 종이 계약 */
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    nullable: true,
  })
  contractMethod: ContractMethod | null;
  /** YYYY-MM-DD */
  @ApiProperty({ nullable: true, type: String, example: '2026-11-01' })
  startDate: string | null;
  /** YYYY-MM-DD. 비어 있으면 기간의 정함이 없는 계약 */
  @ApiProperty({ nullable: true, type: String, example: null })
  endDate: string | null;
  /** 발송 일시 (ISO 8601) — 날인할 때 이 값을 그대로 보낸다(sentAt). 종이 계약이면 null */
  @ApiProperty({ nullable: true, type: String })
  sentAt: string | null;
  /** 날인 기한 (ISO 8601) */
  @ApiProperty({ nullable: true, type: String })
  signDeadlineAt: string | null;
  /**
   * 지금 상태가 된 시각 (ISO 8601). 체결 완료면 날인 일자(종이 계약이면 관리자 등록일), 거부 · 만료 · 종료 · 수정
   * 요청이면 그 일자(상태 이력의 처리 시각). 서명 대기면 마지막 발송 시각(sentAt) — 서명 대기 그대로 다시 보내면
   * 이력이 쌓이지 않아 발송 일시를 쓴다
   */
  @ApiProperty({ nullable: true, type: String })
  processedAt: string | null;
  /** 지금 날인할 수 있는가 — 서명 대기 · 날인 기한 안 · 재직 중. 날인 요청 팝업(WHALEERP-148)이 쓴다. 본인 대조는 상세에서 */
  awaitingSignature: boolean;
}

export class MyContractListResponseDto {
  /** 날인을 기다리는 계약(기한이 급한 순) 먼저, 그다음 최근 것부터 */
  @ApiProperty({ type: [MyContractListItemDto] })
  items: MyContractListItemDto[];
  total: number;
}

/** 계약서의 근로자 칸 — 관리자가 넣은 값(본인 대조 대상) */
export class MyContractWorkerDto {
  @ApiProperty({ nullable: true, type: String })
  name: string | null;
  @ApiProperty({ nullable: true, type: String })
  phone: string | null;
  /** YYYY-MM-DD */
  @ApiProperty({ nullable: true, type: String })
  birthDate: string | null;
  @ApiProperty({ enum: Gender, enumName: 'Gender', nullable: true })
  gender: Gender | null;
  isForeigner: boolean;
  /** 직무 — 직원 레코드 값 */
  jobTitle: string;
  /** 주소 — 날인할 때 계정 주소로 고정된다. 날인 전이면 비어 있다(본인인증 정보의 주소를 보인다) */
  @ApiProperty({ nullable: true, type: String })
  zipCode: string | null;
  @ApiProperty({ nullable: true, type: String })
  address: string | null;
  @ApiProperty({ nullable: true, type: String })
  addressDetail: string | null;
}

/** 계약서의 사용자 칸 — 근무지 점포와 그 사업자 정보. 사업자 정보는 등록 전이면 비어 있다 */
export class MyContractEmployerDto {
  storeName: string;
  @ApiProperty({ nullable: true, type: String })
  storePhone: string | null;
  @ApiProperty({ nullable: true, type: String })
  storeZipCode: string | null;
  @ApiProperty({ nullable: true, type: String })
  storeAddress: string | null;
  @ApiProperty({ nullable: true, type: String })
  storeAddressDetail: string | null;
  /** 상호 */
  @ApiProperty({ nullable: true, type: String })
  tradeName: string | null;
  /** 사업자등록번호 */
  @ApiProperty({ nullable: true, type: String })
  registrationNumber: string | null;
  /** 대표자 */
  @ApiProperty({ nullable: true, type: String })
  ceoName: string | null;
  /** 사업장 주소 */
  @ApiProperty({ nullable: true, type: String })
  bizZipCode: string | null;
  @ApiProperty({ nullable: true, type: String })
  bizAddress: string | null;
  @ApiProperty({ nullable: true, type: String })
  bizAddressDetail: string | null;
}

/** 본인인증으로 확인된 정보 — 내 계정 값(가입 때 입력, 대조 기준) */
export class MyContractAccountDto {
  name: string;
  phone: string;
  /** YYYY-MM-DD */
  birthDate: string;
  @ApiProperty({ enum: Gender, enumName: 'Gender', nullable: true })
  gender: Gender | null;
  isForeigner: boolean;
  @ApiProperty({ nullable: true, type: String })
  zipCode: string | null;
  @ApiProperty({ nullable: true, type: String })
  address: string | null;
  @ApiProperty({ nullable: true, type: String })
  addressDetail: string | null;
}

/** 계약에 붙은 파일 — 종이 계약 날인본 · 임금계약서 등. 직원 필기 서명은 싣지 않는다. 내려받기는 GET /me/contracts/:contractId/documents/:contractDocumentId/download-url */
export class MyContractDocumentDto {
  contractDocumentId: number;
  @ApiProperty({ enum: ContractDocumentKind, enumName: 'ContractDocumentKind' })
  kind: ContractDocumentKind;
  fileName: string;
}

/** 직원 앱 근로계약 상세 (GET /me/contracts/:contractId, WHALEERP-610) — 근무 조건은 관리자 상세와 같은 칸 */
export class MyContractDetailDto extends ContractTermsDto {
  contractId: number;
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  status: ContractStatus;
  storeId: number;
  @ApiProperty({
    enum: EmploymentType,
    enumName: 'EmploymentType',
    nullable: true,
  })
  employmentType: EmploymentType | null;
  @ApiProperty({
    enum: ContractMethod,
    enumName: 'ContractMethod',
    nullable: true,
  })
  contractMethod: ContractMethod | null;
  /** 발송 일시 (ISO 8601) — 날인할 때 그대로 보낸다(sentAt). 다르면 409 CONTRACT_RESENT */
  @ApiProperty({ nullable: true, type: String })
  sentAt: string | null;
  @ApiProperty({ nullable: true, type: String })
  signDeadlineAt: string | null;
  /** 목록과 같다 — 지금 상태가 된 시각 */
  @ApiProperty({ nullable: true, type: String })
  processedAt: string | null;
  /** 목록과 같다 — 서명 대기 · 기한 안 · 재직 중 */
  awaitingSignature: boolean;
  /** 지금 날인하면 받는가 — awaitingSignature 이고 본인 대조가 맞을 때. 날인 API 와 같은 판정이다 */
  signable: boolean;
  /** 계약서 값과 계정 값이 다른 항목 — 날인 API 의 409 IDENTITY_MISMATCH 와 같다. 다르면 직원은 수정 요청을 낸다 */
  @ApiProperty({
    enum: IDENTITY_FIELDS,
    enumName: 'IdentityField',
    isArray: true,
  })
  mismatches: IdentityField[];
  @ApiProperty({ type: MyContractWorkerDto })
  worker: MyContractWorkerDto;
  @ApiProperty({ type: MyContractEmployerDto })
  employer: MyContractEmployerDto;
  @ApiProperty({ type: MyContractAccountDto })
  account: MyContractAccountDto;
  @ApiProperty({ type: [MyContractDocumentDto] })
  documents: MyContractDocumentDto[];
}
