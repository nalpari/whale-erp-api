import { ContractDocumentKind, ContractStatus, Prisma } from '@prisma/client';

/**
 * 직원 앱의 「내 계약」 — 날인 · 거부 · 수정 요청(WHALEERP-145)과 조회(610)가 같은 기준을 쓴다. 내 계정에 이어진 직원
 * 레코드의 계약 중 서명 대기 이후다. 임시저장 · 발송 대기는 아직 직원에게 간 계약이 아니고(목업 「발송 대기는 목록에
 * 없다」), 소속 확인 대기 계약(후보 계정만)과 남의 계약도 없는 것과 같다 — 모두 같은 404 본문.
 */
export const MY_CONTRACT_STATUSES: ContractStatus[] = [
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
  'SIGNED',
  'REJECTED',
  'EXPIRED',
  'ENDED',
];

export const myContractWhere = (accountId: number) =>
  ({
    status: { in: MY_CONTRACT_STATUSES },
    staffMember: { accountId },
  }) satisfies Prisma.ContractWhereInput;

/** 직원 앱이 쓰는 파일 종류 — 처리 완료본 · 종이 계약 날인본 · 임금계약서(whale-erp-staff contract-rules signedCopyOf · paperDocuments) */
export const MY_DOCUMENT_KINDS: ContractDocumentKind[] = [
  'SIGNED_COPY',
  'PAPER_EMPLOYMENT_CONTRACT',
  'WAGE_CONTRACT',
];

/**
 * 직원 앱에 보이는 그 계약의 파일 — 상세 documents 와 내려받기가 같이 쓴다. 쓰는 종류만 연다(새 종류가 생겨도 저절로 열리지
 * 않게). 필기 서명은 처리 완료본의 재료이고, 보낸 원본은 관리자가 근로자 정보를 고쳐 다시 보내기 전 원본이나 재발송이 실패해
 * 발송 일시가 앞 발송으로 되돌아간 계약의 원본에 다른 사람의 이름 · 생년월일 · 번호가 들어 있을 수 있다(api #211 리뷰 두 번).
 * 관리자 상세는 기록이라 모두 본다.
 */
export const myDocumentWhere = (contractId: number) =>
  ({
    contractId,
    kind: { in: MY_DOCUMENT_KINDS },
  }) satisfies Prisma.ContractDocumentWhereInput;

export const MY_CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다.';
