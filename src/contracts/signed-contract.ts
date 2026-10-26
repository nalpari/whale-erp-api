import { Prisma } from '@prisma/client';

/**
 * 체결을 거친 근로계약 — 지금 체결 완료이거나, 체결된 뒤 종료(ENDED)된 계약(2026-10-21 재영 A안 · PAY-11). 하루 배치가 종료일이
 * 지난 체결 완료를 종료로 바꾸므로(WHALEERP-152) 「지금 체결 완료」만 보면 계약이 끝났어도 계속 일하는 직원 · 지난 급여 기간의
 * 계약이 빠진다. 체결을 거쳤는지는 상태 이력의 SIGNED 로 본다(종이 계약은 등록 때, 전자계약은 날인 때 남는다) — 날인 전에
 * 종료 · 거부 · 만료된 계약은 넣지 않는다. 지금 체결 완료인 계약은 이력을 보지 않는다(이력 없이 넣은 데이터도 빠지지 않게).
 */
export const SIGNED_ONCE = {
  OR: [
    { status: 'SIGNED' },
    {
      status: 'ENDED',
      contractStatusHistories: { some: { toStatus: 'SIGNED' } },
    },
  ],
} as const satisfies Prisma.ContractWhereInput;
