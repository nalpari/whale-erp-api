import { Prisma } from '@prisma/client';
import { applyNewPassword } from './apply-new-password';

describe('applyNewPassword', () => {
  const now = new Date('2026-10-13T03:00:00.000Z');
  let tx: {
    account: { update: jest.Mock };
    passwordResetPin: { updateMany: jest.Mock };
    passwordResetLink: { updateMany: jest.Mock };
    emailChangePin: { updateMany: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sessions: { revokeAll: jest.Mock };

  beforeEach(() => {
    tx = {
      account: { update: jest.fn().mockResolvedValue({}) },
      passwordResetPin: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      passwordResetLink: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      emailChangePin: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(0) };
  });

  const run = (over: Partial<Parameters<typeof applyNewPassword>[2]> = {}) =>
    applyNewPassword(tx as unknown as Prisma.TransactionClient, sessions, {
      accountId: 7,
      passwordHash: 'hash:new',
      now,
      channel: 'PIN_RESET',
      ...over,
    });

  it('비밀번호를 바꾸고 로그인 실패 횟수와 잠금을 지운다', async () => {
    await run();
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { accountId: 7 },
      data: {
        passwordHash: 'hash:new',
        failedLoginCount: 0,
        lockExpiresAt: null,
      },
    });
  });

  it('그 계정의 열린 핀과 열린 링크를 모두 닫는다 — 어느 쪽으로 정했든 남은 길을 막는다', async () => {
    await run();
    expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
      where: { accountId: 7, usedAt: null },
      data: { usedAt: now },
    });
    expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
      where: { accountId: 7, closedAt: null },
      data: { closedAt: now },
    });
  });

  it('열린 이메일 변경 핀도 닫는다 — 핀은 그때의 비밀번호를 확인하고 냈으니, 비밀번호가 바뀌면 그 확인도 끝난다 (WHALEERP-607)', async () => {
    await run({ channel: 'SELF', keepSessionId: 3 });
    expect(tx.emailChangePin.updateMany).toHaveBeenCalledWith({
      where: { accountId: 7, usedAt: null },
      data: { usedAt: now },
    });
  });

  it('모든 기기의 접속을 같은 트랜잭션에서 끊는다', async () => {
    await run();
    expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx);
  });

  it('본인 핀이면 요청 관리자 없이 이력을 남긴다 — 값은 남기지 않는다', async () => {
    await run();
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: { accountId: 7, field: 'PASSWORD', channel: 'PIN_RESET' },
    });
  });

  it('본인이 바꾸면(SELF) 바꾼 기기의 접속만 남기고 나머지를 끊는다', async () => {
    await run({ channel: 'SELF', keepSessionId: 11 });
    expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx, 11);
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: { accountId: 7, field: 'PASSWORD', channel: 'SELF' },
    });
  });

  it('관리자 초기화면 요청 관리자를 이력에 남긴다', async () => {
    await run({ channel: 'ADMIN_RESET', requestedBy: 31 });
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: {
        accountId: 7,
        field: 'PASSWORD',
        channel: 'ADMIN_RESET',
        requestedBy: 31,
      },
    });
  });
});
