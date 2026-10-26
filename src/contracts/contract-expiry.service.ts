import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addDays, kstToday } from '../staff-members/kst-date';
import { transitionMany, transitionManyWithHistory } from './contract-status';

/** 갱신 예정 — 계약 종료일 며칠 전에 알리는가(관리자 웹 · 직원 요약 RENEWAL_NOTICE_DAYS 와 같다) */
export const RENEWAL_NOTICE_DAYS = 30;

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
   *   않게 날짜 하나가 아니라 범위로 고른다. 알림은 커밋 뒤 보낸다(실패해도 다시 보내지 않는다 — 계약마다 한 번).
   */
  async runDaily(
    tx: Prisma.TransactionClient,
    now = new Date(),
  ): Promise<ContractDailyResult> {
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
    const today = kstToday(now);
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
        endDate: { gte: today, lte: addDays(today, RENEWAL_NOTICE_DAYS) },
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
