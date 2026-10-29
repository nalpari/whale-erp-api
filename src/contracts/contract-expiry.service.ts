import { Injectable } from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import { addDays, kstToday } from '../staff-members/kst-date';
import { RENEWAL_NOTICE_DAYS } from './contract-renewal';
import { transitionMany, transitionManyWithHistory } from './contract-status';

/** 갱신 예정 대상이 아니게 하는 같은 직원의 다른 계약 — 진행 중(새 계약을 이미 쓰거나 보냄) */
const IN_PROGRESS: readonly ContractStatus[] = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
];

/** 하루 배치가 바꾼 것. 만료 · 갱신 예정은 커밋 뒤 관리자에게 알린다(ContractNoticeService) */
export type ContractDailyResult = {
  /** 날인 기한이 지나 만료한 계약과 그 상태 이력 — 이력 ID 가 만료 알림의 사건 키다 */
  expired: { contractId: number; historyId: number }[];
  /** 기한이 지나 만료한 초대 수 */
  invitationsExpired: number;
  /** 계약 종료일이 지나 종료한 체결 완료 계약 */
  ended: number[];
  /** 이번에 갱신 예정으로 잡은 계약(보낸 때를 남겼다 — 다음 실행에서 다시 잡지 않는다) */
  renewalDue: number[];
};

/**
 * 갱신 예정 후보 — 종료일이 from ~ to(둘 다 포함)인 재직 직원의 체결 완료 계약. 고른 뒤 needsRenewal 로 거른다. 하루 배치와
 * 로그인 후 홈의 경고 밴드(종료일 7일 안)가 같이 쓴다 — 배치는 아직 알리지 않은 것만 더 거른다.
 */
export const renewalCandidateWhere = (from: Date, to: Date) =>
  ({
    status: 'SIGNED',
    endDate: { gte: from, lte: to },
    staffMember: { employmentStatus: 'EMPLOYED' },
  }) satisfies Prisma.ContractWhereInput;

/** needsRenewal 이 읽는 칸 */
export const RENEWAL_CANDIDATE_SELECT = {
  contractId: true,
  endDate: true,
  staffMember: {
    select: {
      retiredDate: true,
      contracts: { select: { contractId: true, status: true, endDate: true } },
    },
  },
} as const satisfies Prisma.ContractSelect;

/** 갱신 예정 후보 — 이 계약의 종료일과 같은 직원의 퇴직일 · 다른 계약을 견줘 거른다 */
type RenewalCandidate = {
  contractId: number;
  endDate: Date | null;
  staffMember: {
    retiredDate: Date | null;
    contracts: {
      contractId: number;
      status: ContractStatus | null;
      endDate: Date | null;
    }[];
  };
};

/**
 * 「새 계약을 만들어 주세요」가 필요한가 — 이 계약의 종료일 기준으로 본다. 그 날까지 퇴직하면(퇴직일 ≤ 종료일) 필요 없고, 같은
 * 직원에게 새 계약이 이미 진행 중이거나 이 계약보다 늦게 끝나는(기간의 정함이 없는) 체결 완료가 있으면 이미 갱신했다. 퇴직일이
 * 종료일 뒤면 계약이 끝나도 계속 일하므로 필요하다(api #150 리뷰 — 범위 끝이 아니라 이 계약의 종료일과 견준다).
 */
export function needsRenewal(c: RenewalCandidate): boolean {
  const end = c.endDate;
  if (!end) return false;
  const retired = c.staffMember.retiredDate;
  if (retired && retired.getTime() <= end.getTime()) return false;
  return !c.staffMember.contracts.some(
    (o) =>
      o.contractId !== c.contractId &&
      ((o.status !== null && IN_PROGRESS.includes(o.status)) ||
        (o.status === 'SIGNED' &&
          (o.endDate === null || o.endDate.getTime() > end.getTime()))),
  );
}

/**
 * 레코드마다 가장 늦게 시작한(오늘까지) 체결을 거친 계약의 고용 형태 · 직무 — 재계약이 아닌 계약도, 기간이 끝나 배치가 닫은
 * 계약(SIGNED_ONCE)도(api #157 code-review). 시작일이 같으면 id 가 큰 것 — applyStartedTerms 와 같은 기준이다.
 */
const LATEST_STARTED_SIGNED = (today: Date) => Prisma.sql`
  SELECT DISTINCT ON (c.staff_member_id) c.staff_member_id, c.employment_type, c.job_title
  FROM contracts c
  WHERE c.start_date <= ${today}
    AND (c.status = 'SIGNED' OR (c.status = 'ENDED' AND EXISTS (
      SELECT 1 FROM contract_status_histories h
      WHERE h.contract_id = c.contract_id
        AND h.from_status = 'SIGNED' AND h.to_status = 'ENDED' AND h.actor = 'SYSTEM')))
  ORDER BY c.staff_member_id, c.start_date DESC, c.contract_id DESC`;

/** 지금 효력인 계약의 조건이 아직 옮겨지지 않은 직원 — 잠글 행 */
const STARTED_TERMS_STAFF = (today: Date) => Prisma.sql`
  SELECT s.staff_member_id FROM staff_members s
  JOIN (${LATEST_STARTED_SIGNED(today)}) r ON r.staff_member_id = s.staff_member_id
  WHERE s.employment_type IS DISTINCT FROM COALESCE(r.employment_type, s.employment_type)
    OR s.job_title IS DISTINCT FROM COALESCE(r.job_title, s.job_title)`;

@Injectable()
export class ContractExpiryService {
  /**
   * 근로계약 하루 배치(WHALEERP-152). 한 트랜잭션에서 차례로 한다 — 모두 조건부 UPDATE 라 여러 번 실행해도 같은 행을 두 번
   * 처리하지 않는다.
   * - 날인 기한이 지난 서명 대기 계약을 만료로 바꾸고 상태 이력을 남긴다. 같은 순간 직원이 서명해도, 기본 격리 수준(READ
   *   COMMITTED)의 UPDATE 는 행 잠금을 기다린 뒤 조건을 다시 보므로 체결 완료된 계약을 만료시키지 않는다. 반대 순서(만료 뒤
   *   서명)는 서명 쪽 UPDATE 도 상태 조건을 걸어야 막힌다. 발송 대기(가입 초대 · 소속 추가 확인 요청에 응답 없음)는 만료하지
   *   않는다 — 만료 계약은 근로계약 상세에서만 다시 보내(WHALEERP-153) 직원 목록의 「초대 만료 → 재발송」이 막힌다(api #150
   *   리뷰). 초대 · 요청만 만료된다.
   * - 기한(expires_at)이 지난 「보냄」 초대를 만료로 바꾼다 — 가입은 기한으로 이미 막지만 직원 목록 상태가 「초대 발송」으로
   *   남았다. 계약은 발송 대기 그대로라 재발송할 수 있다.
   * - 계약 종료일이 지난(한국 날짜로 오늘보다 앞) 체결 완료 계약을 종료로 바꾼다. 재계약(WHALEERP-156)으로 이어지는 계약이
   *   체결 완료이고 그 시작일이 오늘이거나 지났으면 앞 계약도 종료로 바꾼다 — 앞 계약의 종료일은 고치지 않는다(2026-10-26
   *   김민식). 체결을 거친 종료 계약은 재직 직원 · 급여 기간의 효력 계약에 그대로 든다(SIGNED_ONCE).
   * - 종료일이 오늘부터 30일 안인 체결 완료 계약 가운데 아직 알리지 않았고 갱신이 필요한 것(needsRenewal)에 보낸 때를 남기고
   *   돌려준다 — 하루를 걸러도 빠지지 않게 날짜 하나가 아니라 범위로 고른다. 재직 중인 직원만. 알림은 커밋 뒤 보낸다(실패해도
   *   다시 보내지 않는다 — 계약마다 한 번).
   *
   * 잠금 순서: 이 배치가 바꿀 계약 · 초대의 직원 행을 id 순으로 먼저 잠근다(직원 → 초대 → 계약 — 코드베이스 규칙). 같은 자정에
   * 도는 퇴직 확정(직원 → 초대 → 계약) · 가입 · 계약 대체(직원 → 계약)가 같은 순서로 줄을 서 교착하지 않는다 — 계약부터 잡으면
   * 퇴직 확정이 초대를 쥔 채 계약을 기다리는 사이 이 배치가 계약을 쥔 채 초대를 기다린다(api #150 리뷰). 종료 · 갱신 예정 대상
   * (종료일이 갱신 예정 범위 끝까지인 체결 완료)의 직원도 잡는다 — 갱신 예정 후보를 읽은 뒤 표시할 때까지 그 직원의 다른 계약이
   * 바뀌지 않는다.
   */
  async runDaily(
    tx: Prisma.TransactionClient,
    now = new Date(),
  ): Promise<ContractDailyResult> {
    const today = kstToday(now);
    const renewalEnd = addDays(today, RENEWAL_NOTICE_DAYS);
    await tx.$executeRaw`
      SELECT 1 FROM staff_members
      WHERE staff_member_id IN (
        SELECT staff_member_id FROM contracts
        WHERE status = 'PENDING_SIGNATURE' AND sign_deadline_at <= ${now}
        UNION
        SELECT staff_member_id FROM contracts
        WHERE status = 'SIGNED' AND end_date <= ${renewalEnd}
        UNION
        SELECT p.staff_member_id FROM contracts p
        JOIN contracts n ON n.previous_contract_id = p.contract_id
        WHERE p.status = 'SIGNED' AND n.status = 'SIGNED' AND n.start_date <= ${today}
        UNION
        SELECT staff_member_id FROM invitations
        WHERE status = 'SENT' AND expires_at <= ${now}
        UNION
        ${STARTED_TERMS_STAFF(today)}
      )
      ORDER BY staff_member_id
      FOR NO KEY UPDATE`;
    const expired = await transitionManyWithHistory(
      tx,
      { signDeadlineAt: { lte: now } },
      'PENDING_SIGNATURE',
      'EXPIRED',
      'SYSTEM',
    );
    const { count: invitationsExpired } = await tx.invitation.updateMany({
      where: { status: 'SENT', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    const ended = await transitionMany(
      tx,
      {
        OR: [
          { endDate: { lt: today } },
          // 재계약으로 이어지는 계약이 시작했다
          {
            contractsAsPrevious: {
              some: { status: 'SIGNED', startDate: { lte: today } },
            },
          },
        ],
      },
      'SIGNED',
      'ENDED',
      'SYSTEM',
    );
    // 시작한 재계약의 고용 형태 · 직무를 직원 레코드로 옮긴다 — 미리 날인한 재계약은 날인 때 옮기지 않았다(applyStartedTerms,
    // WHALEERP-156). 레코드마다 가장 늦게 시작한 체결 완료 재계약이고, 직원 값과 다를 때만 바꾼다
    await tx.$executeRaw`
      UPDATE staff_members s
      SET employment_type = COALESCE(r.employment_type, s.employment_type),
          job_title = COALESCE(r.job_title, s.job_title)
      FROM (${LATEST_STARTED_SIGNED(today)}) r
      WHERE s.staff_member_id = r.staff_member_id
        AND (s.employment_type IS DISTINCT FROM COALESCE(r.employment_type, s.employment_type)
          OR s.job_title IS DISTINCT FROM COALESCE(r.job_title, s.job_title))`;
    const candidates = await tx.contract.findMany({
      where: {
        ...renewalCandidateWhere(today, renewalEnd),
        renewalNotifiedAt: null,
      },
      select: RENEWAL_CANDIDATE_SELECT,
    });
    const ids = candidates.filter(needsRenewal).map((c) => c.contractId);
    const due = ids.length
      ? await tx.contract.updateManyAndReturn({
          where: { contractId: { in: ids }, renewalNotifiedAt: null },
          data: { renewalNotifiedAt: now },
          select: { contractId: true },
        })
      : [];
    return {
      expired,
      invitationsExpired,
      ended,
      renewalDue: due.map((c) => c.contractId),
    };
  }
}
