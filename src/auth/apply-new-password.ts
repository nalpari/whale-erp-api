import { AccountChangeChannel, Prisma } from '@prisma/client';
import type { AuthSessionService } from '../auth-session/auth-session.service';
import { CLEARED_ATTEMPT_STATE } from './attempt-lock';

export interface NewPassword {
  accountId: number;
  passwordHash: string;
  now: Date;
  channel: AccountChangeChannel;
  /** 관리자 초기화일 때 요청 관리자. 본인 핀 · 내 정보 변경(SELF)이면 없다. */
  requestedBy?: number;
  /** 남길 접속. 본인이 내 정보에서 바꾸면(SELF) 바꾼 기기는 로그인을 잇는다(WHALEERP-192). */
  keepSessionId?: number;
}

/**
 * 새 비밀번호를 적용한다. 본인 핀(WHALEERP-171) · 관리자 링크(WHALEERP-172) · 내 정보 변경(WHALEERP-192)이 같은 규칙을
 * 쓰게 한 곳에 둔다.
 * 부르는 쪽의 트랜잭션 안에서 부른다 — 비밀번호만 바뀌고 링크 · 핀 · 다른 기기의 접속이 남는 순간이 없게.
 *
 * 핀 · 링크 · 내 정보 변경 어느 쪽으로 정했든 그 계정의 열린 링크와 핀을 모두 닫는다(WHALEERP-172). 하나라도 남으면 이미 바꾼
 * 비밀번호를 그 길로 다시 바꿀 수 있다.
 */
export async function applyNewPassword(
  tx: Prisma.TransactionClient,
  sessions: Pick<AuthSessionService, 'revokeAll'>,
  {
    accountId,
    passwordHash,
    now,
    channel,
    requestedBy,
    keepSessionId,
  }: NewPassword,
): Promise<void> {
  await tx.account.update({
    where: { accountId },
    data: {
      passwordHash,
      failedLoginCount: CLEARED_ATTEMPT_STATE.failedCount,
      lockExpiresAt: CLEARED_ATTEMPT_STATE.lockExpiresAt,
    },
  });
  await tx.passwordResetPin.updateMany({
    where: { accountId, usedAt: null },
    data: { usedAt: now },
  });
  await tx.passwordResetLink.updateMany({
    where: { accountId, closedAt: null },
    data: { closedAt: now },
  });
  if (keepSessionId === undefined) await sessions.revokeAll(accountId, tx);
  else await sessions.revokeAll(accountId, tx, keepSessionId);
  // 값은 남기지 않는다. 누가 어떤 경로로 바꿨는지만 남는다.
  await tx.accountChangeHistory.create({
    data: {
      accountId,
      field: 'PASSWORD',
      channel,
      ...(requestedBy === undefined ? {} : { requestedBy }),
    },
  });
}
