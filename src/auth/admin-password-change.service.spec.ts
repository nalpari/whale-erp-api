import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ADMIN_SESSION_LIFETIME_MS } from '../admin-session/admin-session.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminPasswordChangeService,
  RELOGIN_REQUIRED_MESSAGE,
  TERMS_REQUIRED_MESSAGE,
} from './admin-password-change.service';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import { hashPassword, verifyPassword } from './password';

const OWN = 'Own-pass-1!';
const TEMP = 'Temp-pass-1!';
const NEW = 'New-pass-1!';

describe('AdminPasswordChangeService', () => {
  let service: AdminPasswordChangeService;
  let ownHash: string;
  let tempHash: string;
  let tx: {
    $queryRaw: jest.Mock;
    adminAccount: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    temporaryPassword: { findFirst: jest.Mock; updateMany: jest.Mock };
    termsVersion: { findMany: jest.Mock };
    termsAgreementLog: { createMany: jest.Mock };
    adminChangeHistory: { create: jest.Mock };
    adminSession: { updateMany: jest.Mock };
  };
  const now = new Date('2026-10-13T05:00:00Z');

  beforeAll(async () => {
    ownHash = await hashPassword(OWN);
    tempHash = await hashPassword(TEMP);
  });

  const account = (over: Record<string, unknown> = {}) => ({
    loginId: 'whale01',
    passwordHash: ownHash,
    isPasswordChangeRequired: true,
    joinPathCode: 'SIGNUP',
    termsAgreedAt: null,
    ...over,
  });
  const dto = (over: Record<string, unknown> = {}) => ({
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
      temporaryPassword: {
        findFirst: jest.fn().mockResolvedValue({ passwordHash: tempHash }),
        updateMany: jest.fn(),
      },
      termsVersion: {
        findMany: jest.fn().mockResolvedValue([
          { termsVersionId: 11, termsTypeCode: 'TERMS_SERVICE' },
          { termsVersionId: 12, termsTypeCode: 'PRIVACY_COLLECT' },
        ]),
      },
      termsAgreementLog: { createMany: jest.fn() },
      adminChangeHistory: { create: jest.fn() },
      adminSession: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminPasswordChangeService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile()
    ).get(AdminPasswordChangeService);
  });

  afterEach(() => jest.useRealTimers());

  const change = (over: Record<string, unknown> = {}) =>
    service.changeRequired(7, dto(over), '10.0.0.1');
  const rejectsWith = async (p: Promise<unknown>, message: string) => {
    await expect(p).rejects.toThrow(new BadRequestException(message));
    expect(tx.adminAccount.update).not.toHaveBeenCalled();
  };

  it('바꾸면 새 해시 · 표시 해제 · 임시 비밀번호 전부 만료 · 이력 · 세션은 모두 이어 준다', async () => {
    await change();

    expect(tx.$queryRaw).toHaveBeenCalled(); // 계정 행 잠금
    const [{ data }] = tx.adminAccount.update.mock.calls[0] as [
      { data: { passwordHash: string; isPasswordChangeRequired: boolean } },
    ];
    expect(data.isPasswordChangeRequired).toBe(false);
    await expect(verifyPassword(NEW, data.passwordHash)).resolves.toBe(true);
    expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: 7, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    expect(tx.adminChangeHistory.create).toHaveBeenCalledWith({
      data: {
        adminAccountId: 7,
        field: '비밀번호',
        afterValue: '강제 변경',
        changedBy: 7,
        changedAt: now,
      },
    });
    // 임시 비밀번호 만료로 잘려 있던 세션도 이 시각부터 1시간으로 — 다른 기기도 끊지 않는다.
    expect(tx.adminSession.updateMany).toHaveBeenCalledWith({
      where: {
        adminAccountId: 7,
        revokedAt: null,
        isDeleted: false,
        expiresAt: { gt: now },
      },
      data: {
        refreshLastUsedAt: now,
        expiresAt: new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS),
      },
    });
    // 약관이 필요 없는 계정은 동의를 받지 않는다.
    expect(tx.termsAgreementLog.createMany).not.toHaveBeenCalled();
  });

  it('강제 변경 대상이 아니면 409', async () => {
    tx.adminAccount.findUniqueOrThrow.mockResolvedValue(
      account({ isPasswordChangeRequired: false }),
    );
    await expect(change()).rejects.toBeInstanceOf(ConflictException);
  });

  it('로그인에 쓴 임시 비밀번호가 없으면(만료 · 다시 발급 · 관리자 초기화) 다시 로그인하라는 401 이고 저장하지 않는다', async () => {
    tx.temporaryPassword.findFirst.mockResolvedValue(null);
    await expect(change()).rejects.toThrow(
      new UnauthorizedException(RELOGIN_REQUIRED_MESSAGE),
    );
    expect(tx.temporaryPassword.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          adminAccountId: 7,
          usedAt: { not: null },
          invalidatedAt: null,
          isDeleted: false,
          expiresAt: { gt: now },
        },
      }),
    );
    expect(tx.adminAccount.update).not.toHaveBeenCalled();
  });

  describe('정책 문구는 정책 순서로 하나만', () => {
    it('조합 · 길이', () =>
      rejectsWith(
        change({ newPassword: 'short', newPasswordConfirm: 'x' }),
        ADMIN_PASSWORD_MESSAGES.combination,
      ));

    it('현재 비밀번호와 같으면', () =>
      rejectsWith(
        change({ newPassword: OWN, newPasswordConfirm: OWN }),
        ADMIN_PASSWORD_MESSAGES.sameAsCurrent,
      ));

    it('발급받은 비밀번호와 같으면', () =>
      rejectsWith(
        change({ newPassword: TEMP, newPasswordConfirm: TEMP }),
        ADMIN_PASSWORD_MESSAGES.sameAsIssued,
      ));

    it('확인 값이 다르면 — 맨 마지막', () =>
      rejectsWith(
        change({ newPasswordConfirm: 'Other-pass-1!' }),
        ADMIN_PASSWORD_MESSAGES.confirmMismatch,
      ));
  });

  describe('플랫폼등록이고 약관 미동의인 계정', () => {
    beforeEach(() =>
      tx.adminAccount.findUniqueOrThrow.mockResolvedValue(
        account({ joinPathCode: 'PLATFORM_REGISTERED', passwordHash: '!' }),
      ),
    );

    it('약관에 동의하지 않으면 비밀번호도 바꾸지 않고 400', () =>
      rejectsWith(change(), TERMS_REQUIRED_MESSAGE));

    it('동의하면 지금 쓰는 두 약관 버전으로 이력을 남기고 계정에 같이 저장한다', async () => {
      await change({ isTermsAgreed: true });

      expect(tx.termsVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            termsTypeCode: { in: ['TERMS_SERVICE', 'PRIVACY_COLLECT'] },
            isActive: true,
            isDeleted: false,
          },
        }),
      );
      expect(tx.termsAgreementLog.createMany).toHaveBeenCalledWith({
        data: [11, 12].map((termsVersionId) => ({
          adminAccountId: 7,
          termsVersionId,
          isAgreed: true,
          agreedAt: now,
          channel: 'FIRST_LOGIN',
          clientAddress: '10.0.0.1',
        })),
      });
      const [{ data }] = tx.adminAccount.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({
        isPasswordChangeRequired: false,
        termsOfUseVersionId: 11,
        termsOfUseAgreedAt: now,
        privacyVersionId: 12,
        privacyAgreedAt: now,
        termsAgreedAt: now,
      });
    });

    it('쓰는 약관 버전이 둘 다 있지 않으면 던진다 — 반쪽 동의를 남기지 않게', async () => {
      tx.termsVersion.findMany.mockResolvedValue([
        { termsVersionId: 11, termsTypeCode: 'TERMS_SERVICE' },
      ]);
      await expect(change({ isTermsAgreed: true })).rejects.toThrow();
      expect(tx.adminAccount.update).not.toHaveBeenCalled();
    });
  });
});
