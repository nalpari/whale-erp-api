import { ContractStatus, Prisma } from '@prisma/client';

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

export const MY_CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다.';
