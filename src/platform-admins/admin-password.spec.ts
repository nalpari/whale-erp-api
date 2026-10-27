import type { Prisma } from '@prisma/client';
import {
  LOCKED_PASSWORD,
  voidTempPasswordsForEmailChange,
} from './admin-password';

describe('voidTempPasswordsForEmailChange', () => {
  const tx = {
    temporaryPassword: { updateMany: jest.fn() },
    adminAccount: { updateMany: jest.fn() },
  };
  const run = () =>
    voidTempPasswordsForEmailChange(
      tx as unknown as Prisma.TransactionClient,
      7,
      3,
    );

  beforeEach(() => jest.clearAllMocks());

  it('쓰지 않은 임시 비밀번호를 용도와 상관없이 모두 막는다 — 옛 주소의 주인이 쓸 수 있다', async () => {
    tx.temporaryPassword.updateMany.mockResolvedValue({ count: 0 });
    await run();
    expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
      where: {
        adminAccountId: 7,
        usedAt: null,
        invalidatedAt: null,
        isDeleted: false,
      },
      data: { invalidatedAt: expect.any(Date) as Date, updatedBy: 3 },
    });
  });

  it('막은 것이 없으면 「미발송」을 건드리지 않는다', async () => {
    tx.temporaryPassword.updateMany.mockResolvedValue({ count: 0 });
    await run();
    expect(tx.adminAccount.updateMany).not.toHaveBeenCalled();
  });

  it('막았으면 쓸 수 있는 비밀번호가 없는 계정만 「미발송」을 켠다 — 비밀번호 찾기의 임시 비밀번호만 막힌 계정은 원래 비밀번호로 로그인된다', async () => {
    tx.temporaryPassword.updateMany.mockResolvedValue({ count: 1 });
    await run();
    expect(tx.adminAccount.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: 7, passwordHash: LOCKED_PASSWORD },
      data: { isInitialPasswordUnsent: true },
    });
  });
});
