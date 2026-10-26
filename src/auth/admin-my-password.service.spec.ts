import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminMyPasswordService } from './admin-my-password.service';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import { hashPassword, verifyPassword } from './password';

const OWN = 'Own-pass-1!';
const NEW = 'New-pass-1!';

describe('AdminMyPasswordService', () => {
  let service: AdminMyPasswordService;
  let ownHash: string;
  let tx: {
    $queryRaw: jest.Mock;
    adminAccount: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    adminChangeHistory: { create: jest.Mock };
    temporaryPassword: { updateMany: jest.Mock };
  };
  const now = new Date('2026-10-26T05:00:00Z');

  beforeAll(async () => {
    ownHash = await hashPassword(OWN);
  });

  const account = (over: Record<string, unknown> = {}) => ({
    loginId: 'whale01',
    passwordHash: ownHash,
    ...over,
  });
  const dto = (over: Record<string, unknown> = {}) => ({
    currentPassword: OWN,
    newPassword: NEW,
    newPasswordConfirm: NEW,
    ...over,
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(now);
    tx = {
      $queryRaw: jest.fn(),
      adminAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(account()),
        update: jest.fn(),
      },
      adminChangeHistory: { create: jest.fn() },
      temporaryPassword: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminMyPasswordService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile()
    ).get(AdminMyPasswordService);
  });

  afterEach(() => jest.useRealTimers());

  const change = (over: Record<string, unknown> = {}) =>
    service.change(7, dto(over));
  const rejectsWith = async (p: Promise<unknown>, message: string) => {
    await expect(p).rejects.toThrow(new BadRequestException(message));
    expect(tx.adminAccount.update).not.toHaveBeenCalled();
    expect(tx.adminChangeHistory.create).not.toHaveBeenCalled();
    expect(tx.temporaryPassword.updateMany).not.toHaveBeenCalled();
  };

  it('현재 비밀번호를 확인하고 바꾸면 새 해시 · 이력을 남기고 세션은 건드리지 않는다', async () => {
    await change();

    expect(tx.$queryRaw).toHaveBeenCalled(); // 계정 행 잠금
    const [{ data }] = tx.adminAccount.update.mock.calls[0] as [
      { data: { passwordHash: string } },
    ];
    await expect(verifyPassword(NEW, data.passwordHash)).resolves.toBe(true);
    expect(tx.adminChangeHistory.create).toHaveBeenCalledWith({
      data: {
        adminAccountId: 7,
        field: '비밀번호',
        afterValue: '변경',
        changedBy: 7,
        changedAt: now,
      },
    });
    // 쓰지 않은 찾기용 임시 비밀번호도 일반 로그인과 같은 규칙으로 무효화한다(코드 리뷰로 찾음, 2026-10-26).
    expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
      where: {
        adminAccountId: 7,
        purpose: 'TEMPORARY',
        usedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
  });

  it('현재 비밀번호가 틀리면 400 이고 새 비밀번호 규칙은 보지 않는다 — 가장 먼저 걸린다', () =>
    rejectsWith(
      change({ currentPassword: 'wrong-pass', newPassword: 'x' }),
      ADMIN_PASSWORD_MESSAGES.currentMismatch,
    ));

  describe('현재 비밀번호를 맞춘 뒤, 정책 문구는 정책 순서로 하나만', () => {
    it('조합 · 길이', () =>
      rejectsWith(
        change({ newPassword: 'short', newPasswordConfirm: 'x' }),
        ADMIN_PASSWORD_MESSAGES.combination,
      ));

    it('아이디와 같으면', () => {
      // 실제 로그인ID(영문·숫자만)는 조합 규칙(특수문자 필수)을 못 만족해 이 분기까지 못 온다 — 순서만
      // 가려 보려고 로그인ID 를 조합 규칙도 만족하는 값으로 둔다(admin-password-change.service.spec.ts
      // 도 이 분기는 테스트하지 않는다 — 같은 이유).
      tx.adminAccount.findUniqueOrThrow.mockResolvedValue(
        account({ loginId: 'whale01!' }),
      );
      return rejectsWith(
        change({ newPassword: 'whale01!', newPasswordConfirm: 'whale01!' }),
        ADMIN_PASSWORD_MESSAGES.sameAsLoginId,
      );
    });

    it('허용하지 않는 문자가 섞이면', () =>
      // 조합(영문·숫자·특수문자 8~20자) · 아이디와 다름은 통과하지만 한글이 섞여 허용 문자 규칙에서 걸린다.
      rejectsWith(
        change({ newPassword: 'Abcdef1!가', newPasswordConfirm: 'Abcdef1!가' }),
        ADMIN_PASSWORD_MESSAGES.invalidCharacter,
      ));

    it('현재 비밀번호와 같으면', () =>
      rejectsWith(
        change({ newPassword: OWN, newPasswordConfirm: OWN }),
        ADMIN_PASSWORD_MESSAGES.sameAsCurrent,
      ));

    it('확인 값이 다르면 — 맨 마지막', () =>
      rejectsWith(
        change({ newPasswordConfirm: 'Other-pass-1!' }),
        ADMIN_PASSWORD_MESSAGES.confirmMismatch,
      ));
  });
});
