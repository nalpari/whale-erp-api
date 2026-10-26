import { Prisma } from '@prisma/client';
import { kstToday } from '../staff-members/kst-date';
import { IN_PROGRESS } from './contract-duplicates';
import { LIVE_RENEWAL } from './signed-contract';

/** 거부 · 만료 재발송이 볼 계약 — 그 직원 · 직전 계약 */
export type ReopenTarget = {
  contractId: number;
  storeId: number;
  previousContractId: number | null;
  staffMember: {
    phone: string;
    employmentStatus: string;
    retiredDate: Date | null;
  };
};

/**
 * 거부 · 만료 계약을 다시 살릴 수 없는 까닭(WHALEERP-153) — 없으면 null. 재발송(contract-send)이 409 로, 상세의 canResend 가 버튼을
 * 숨기는 데 함께 쓴다.
 * - 퇴직한 직원(퇴직 확정 · 퇴직일이 지남)에게는 보내지 않는다(CTR-25 — 다시 일하면 새 근로계약서).
 * - 같은 점포 · 같은 번호에 다른 진행 중 계약이 있으면 둘이 함께 살아나지 않게 막는다.
 * - 같은 점포 · 같은 번호에 체결 완료인 다른 계약(이 계약의 직전 계약은 빼고)이 있으면 막는다 — 옛 조건의 계약이 새로 체결된 계약
 *   곁에서 다시 체결되지 않게(api #158 code-review). 이어 일하면 재계약(새 계약)으로 보낸다.
 * - 재계약이면 같은 직전 계약에 이어지는 다른 살아 있는 재계약이 있으면 막는다(한 계약에 살아 있는 재계약은 하나, WHALEERP-156).
 */
export async function reopenBlockOf(
  db: Prisma.TransactionClient,
  c: ReopenTarget,
  now: Date,
): Promise<string | null> {
  const s = c.staffMember;
  if (
    s.employmentStatus === 'RETIRED' ||
    (s.retiredDate !== null && s.retiredDate < kstToday(now))
  )
    return '퇴직한 직원에게는 근로계약서를 다시 보낼 수 없습니다. 다시 일하면 새 근로계약서를 작성해 주세요';
  const sameStaff = {
    contractId: { not: c.contractId },
    storeId: c.storeId,
    staffMember: { phone: s.phone },
  };
  if (
    await db.contract.findFirst({
      where: { ...sameStaff, status: { in: IN_PROGRESS } },
      select: { contractId: true },
    })
  )
    return '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다. 그 근로계약을 확인해 주세요';
  if (
    await db.contract.findFirst({
      where: {
        ...sameStaff,
        status: 'SIGNED',
        ...(c.previousContractId !== null && {
          NOT: { contractId: c.previousContractId },
        }),
      },
      select: { contractId: true },
    })
  )
    return '이 점포에 같은 직원의 체결 완료된 근로계약이 있습니다. 이어 일하면 새 계약(재계약)을 보내 주세요';
  if (
    c.previousContractId !== null &&
    (await db.contract.findFirst({
      where: {
        contractId: { not: c.contractId },
        previousContractId: c.previousContractId,
        ...LIVE_RENEWAL,
      },
      select: { contractId: true },
    }))
  )
    return '직전 계약에 이어지는 다른 재계약이 있습니다. 그 근로계약을 확인해 주세요';
  return null;
}
