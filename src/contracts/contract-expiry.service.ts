import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addDays, kstToday } from '../staff-members/kst-date';
import { RENEWAL_NOTICE_DAYS } from './contract-renewal';
import { transitionMany, transitionManyWithHistory } from './contract-status';

/** 갱신 예정 대상이 아니게 하는 같은 직원의 다른 계약 — 진행 중(새 계약을 이미 쓰거나 보냄) */
const IN_PROGRESS = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
] as const;

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

@Injectable()
export class ContractExpiryService {
  /**
   * 근로계약 하루 배치(WHALEERP-152). 한 트랜잭션에서 차례로 한다 — 모두 조건부 UPDATE 라 여러 번 실행해도 같은 행을 두 번
   * 처리하지 않는다.
   * - 날인 기한이 지난 서명 대기 · 발송 대기 계약을 만료로 바꾸고 상태 이력을 남긴다. 발송 대기는 가입 초대에 30일 안에
   *   가입하지 않은 계약이다(2026-10-26 김민식). 같은 순간 직원이 서명해도, 기본 격리 수준(READ COMMITTED)의 UPDATE 는 행 잠금을
   *   기다린 뒤 조건을 다시 보므로 체결 완료된 계약을 만료시키지 않는다. 반대 순서(만료 뒤 서명)는 서명 쪽 UPDATE 도 상태 조건을
   *   걸어야 막힌다.
   * - 기한(expires_at)이 지난 「보냄」 초대를 만료로 바꾼다 — 가입은 기한으로 이미 막지만 직원 목록 상태가 「초대 발송」으로
   *   남았다.
   * - 계약 종료일이 지난(한국 날짜로 오늘보다 앞) 체결 완료 계약을 종료로 바꾼다.
   * - 종료일이 오늘부터 30일 안인 체결 완료 계약 가운데 아직 알리지 않은 것에 보낸 때를 남기고 돌려준다 — 하루를 걸러도 빠지지
   *   않게 날짜 하나가 아니라 범위로 고른다. 「새 계약을 만들어 주세요」가 필요 없는 경우는 뺀다 — 퇴직했거나 그 범위 안에 퇴직일을
   *   정한 직원(범위 뒤 퇴직일은 계약이 끝나도 계속 일하므로 넣는다), 같은 직원에게 새 계약이 이미 진행 중이거나 더 늦게 끝나는(또는
   *   기간의 정함이 없는) 체결 완료가 있는 경우. 알림은 커밋 뒤 보낸다(실패해도 다시 보내지 않는다 — 계약마다 한 번).
   *
   * 잠금 순서: 이 배치가 바꿀 계약 · 초대의 직원 행을 id 순으로 먼저 잠근다(직원 → 초대 → 계약 — 코드베이스 규칙). 같은 자정에
   * 도는 퇴직 확정(직원 → 초대 → 계약) · 가입 · 계약 대체(직원 → 계약)가 같은 순서로 줄을 서 교착하지 않는다 — 계약부터 잡으면
   * 퇴직 확정이 초대를 쥔 채 계약을 기다리는 사이 이 배치가 계약을 쥔 채 초대를 기다린다(api #150 리뷰). 종료 · 갱신 예정 대상
   * (종료일이 갱신 예정 범위 끝까지인 체결 완료)의 직원도 잡는다.
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
        WHERE status IN ('PENDING_SIGNATURE', 'PENDING_SEND') AND sign_deadline_at <= ${now}
        UNION
        SELECT staff_member_id FROM contracts
        WHERE status = 'SIGNED' AND end_date <= ${renewalEnd}
        UNION
        SELECT staff_member_id FROM invitations
        WHERE status = 'SENT' AND expires_at <= ${now}
      )
      ORDER BY staff_member_id
      FOR NO KEY UPDATE`;
    const overdue = { signDeadlineAt: { lte: now } };
    const expired = [
      ...(await transitionManyWithHistory(
        tx,
        overdue,
        'PENDING_SIGNATURE',
        'EXPIRED',
        'SYSTEM',
      )),
      ...(await transitionManyWithHistory(
        tx,
        overdue,
        'PENDING_SEND',
        'EXPIRED',
        'SYSTEM',
      )),
    ];
    const { count: invitationsExpired } = await tx.invitation.updateMany({
      where: { status: 'SENT', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    const ended = await transitionMany(
      tx,
      { endDate: { lt: today } },
      'SIGNED',
      'ENDED',
      'SYSTEM',
    );
    const due = await tx.contract.updateManyAndReturn({
      where: {
        status: 'SIGNED',
        renewalNotifiedAt: null,
        endDate: { gte: today, lte: renewalEnd },
        staffMember: {
          employmentStatus: 'EMPLOYED',
          OR: [{ retiredDate: null }, { retiredDate: { gt: renewalEnd } }],
          contracts: {
            none: {
              OR: [
                { status: { in: [...IN_PROGRESS] } },
                {
                  status: 'SIGNED',
                  OR: [{ endDate: null }, { endDate: { gt: renewalEnd } }],
                },
              ],
            },
          },
        },
      },
      data: { renewalNotifiedAt: now },
      select: { contractId: true },
    });
    return {
      expired,
      invitationsExpired,
      ended,
      renewalDue: due.map((c) => c.contractId),
    };
  }
}
