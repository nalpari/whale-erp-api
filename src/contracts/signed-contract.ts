import { Prisma } from '@prisma/client';

/**
 * 체결을 거친 근로계약 — 지금 체결 완료이거나, 기간이 끝나 하루 배치가 종료(ENDED)한 계약(2026-10-21 재영 A안 · PAY-11). 하루
 * 배치가 종료일이 지난 체결 완료를 종료로 바꾸므로(WHALEERP-152) 「지금 체결 완료」만 보면 계약이 끝났어도 계속 일하는 직원이
 * 빠진다. 종료는 배치가 체결 완료에서 바꾼 것만 친다(상태 이력 SIGNED → ENDED, 시스템) — 관리자가 대체로 닫은 체결 완료(새 계약이
 * 그 자리를 잇는다)와 날인 전에 닫힌 계약은 넣지 않는다(api #152 리뷰). 「체결 완료였다」를 종료 줄의 from 으로 보므로 체결 이력
 * 없이 넣은 옛 체결 완료도 배치가 닫은 뒤 빠지지 않는다. 지금 체결 완료인 계약은 이력을 보지 않는다. 급여명세서는 대체로 닫힌
 * 계약도 닫힌 날까지 효력으로 따로 본다(payslip-draft validContractWhere).
 */
export const SIGNED_ONCE = {
  OR: [
    { status: 'SIGNED' },
    {
      status: 'ENDED',
      contractStatusHistories: {
        some: { fromStatus: 'SIGNED', toStatus: 'ENDED', actor: 'SYSTEM' },
      },
    },
  ],
} as const satisfies Prisma.ContractWhereInput;

/**
 * 직원의 「가장 최근 계약」에서 뺄 재계약 — 연장(직전 계약이 재직 중인 같은 레코드)인데 임시저장이거나, 거부 · 만료 · 체결 없이 종료로
 * 끝난 재계약(WHALEERP-156). 이런 재계약이 최근 계약으로 서면 지금 효력인 직전 계약의 상태 · 갱신 예정일이 직원 목록 · 상세에서
 * 사라진다(api #157 리뷰). 보내 놓은 재계약(발송 대기 · 서명 대기 · 수정 요청)은 그대로 보인다 — 재계약이 진행 중이라는 뜻이다.
 * 재입사 재계약(직전 계약이 퇴직한 옛 레코드)은 빼지 않는다 — 새 레코드의 하나뿐인 계약이다. 직전 계약 레코드가 재직 중(퇴직일
 * 없음)인지로 가른다 — 연장은 같은 레코드, 재입사는 퇴직한 레코드다.
 */
export const NOT_IDLE_RENEWAL = {
  NOT: {
    // 재계약이 아니면(직전 계약 없음) 거짓이 되게 먼저 둔다 — 관계 필터만 있으면 NULL 이 NOT(...) 을 NULL 로 만들어 재계약이 아닌
    // 임시저장 · 거부 · 만료 계약까지 빠질 수 있다(api #157 code-review)
    previousContractId: { not: null },
    previousContract: {
      staffMember: { employmentStatus: 'EMPLOYED', retiredDate: null },
    },
    OR: [
      { status: { in: ['DRAFT', 'REJECTED', 'EXPIRED'] } },
      // 체결 없이 종료(발송 대기 종료 · 대체로 닫힘) — 배치가 닫은 체결 완료(SIGNED_ONCE)는 남긴다
      { status: 'ENDED', NOT: SIGNED_ONCE },
    ],
  },
} satisfies Prisma.ContractWhereInput;
