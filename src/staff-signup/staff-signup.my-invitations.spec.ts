import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthSessionService } from '../auth-session/auth-session.service';
import type { AccountAuthService } from '../auth/account-auth.service';
import { hashToken } from '../auth/password';
import { hashInvitationCode } from '../contracts/contract-delivery.service';
import type { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { HQ_SHARING_CONSENT_VERSION } from './hq-sharing-consent';
import { StaffSignupService } from './staff-signup.service';

const SECRET = 'jwt-secret-for-staff-signup-test-0123456789';
const TOKEN = 'B'.repeat(43);
const CODE = 'K7Q2M9PX';
const PHONE = '01012345678';
const NOW = new Date('2026-10-20T01:00:00.000Z');
const LATER = new Date('2026-11-19T01:00:00.000Z');

// 로그인 후 초대 코드로 근무지 더하기(WHALEERP-603)
describe('StaffSignupService — 로그인 후 근무지 더하기', () => {
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    invitationCodeAttempt: { findFirst: jest.Mock; create: jest.Mock };
    account: { findUnique: jest.Mock; update: jest.Mock };
    invitation: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    store: { findUnique: jest.Mock };
    staffMember: { updateMany: jest.Mock };
    contract: { updateManyAndReturn: jest.Mock };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };

  const invitation = (overrides: Record<string, unknown> = {}) => ({
    invitationId: 41,
    status: 'SENT',
    expiresAt: LATER,
    staffMember: {
      staffMemberId: 19,
      storeId: 4,
      name: '홍길동',
      phone: PHONE,
      employmentType: 'FULL_TIME',
      accountId: null,
    },
    ...overrides,
  });
  const account = (overrides: Record<string, unknown> = {}) =>
    tx.account.findUnique.mockResolvedValue({
      phone: PHONE,
      status: 'JOINED',
      isHqSharingConsented: false,
      ...overrides,
    });
  const store = (storeTypeCode = 'FRANCHISE') =>
    tx.store.findUnique.mockResolvedValue({
      name: '모리커피 합정점',
      storeTypeCode,
    });
  const service = () =>
    new StaffSignupService(
      prisma as unknown as PrismaService,
      {} as AuthSessionService,
      {} as AccountAuthService,
      {} as OpsNotificationService,
      { get: () => SECRET } as unknown as ConfigService,
    );
  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('던지지 않았다');
  };
  const codeOf = (e: HttpException) =>
    (e.getResponse() as { code?: string }).code;
  const argOf = (m: jest.Mock) =>
    (m.mock.calls[0] as [{ where?: unknown; data?: unknown }])[0];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ phone: PHONE }]),
      invitationCodeAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      account: { findUnique: jest.fn(), update: jest.fn() },
      invitation: {
        findMany: jest.fn().mockResolvedValue([invitation()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ status: 'ACCEPTED' }),
      },
      store: { findUnique: jest.fn() },
      staffMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      contract: {
        updateManyAndReturn: jest.fn().mockResolvedValue([{ contractId: 8 }]),
      },
      contractStatusHistory: {
        createManyAndReturn: jest.fn().mockResolvedValue([]),
      },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    account();
    store();
  });

  afterEach(() => jest.useRealTimers());

  describe('확인', () => {
    it('코드는 계정의 번호와 함께 찾는다 — 번호는 받지 않는다', async () => {
      await expect(
        service().checkForAccount(77, { code: CODE }),
      ).resolves.toEqual({
        storeName: '모리커피 합정점',
        employmentType: 'FULL_TIME',
        expiresAt: LATER,
        phone: PHONE,
        asksHqSharingConsent: true,
      });
      expect(argOf(tx.account.findUnique).where).toEqual({ accountId: 77 });
      expect(argOf(tx.invitation.findMany).where).toEqual({
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        invitationCodeHash: hashInvitationCode(CODE, SECRET),
        staffMember: { phone: PHONE },
      });
    });

    it.each([
      ['직영 점포', 'DIRECT', false, false],
      ['가맹 점포 · 계정이 이미 동의', 'FRANCHISE', true, false],
      ['가맹 점포 · 아직 동의 안 함', 'FRANCHISE', false, true],
    ])('%s — 동의를 묻는가 %s', async (_label, type, consented, asks) => {
      store(type);
      account({
        isHqSharingConsented: consented,
        hqSharingConsentVersion: 'v1.0',
      });
      await expect(
        service().checkForAccount(77, { code: CODE }),
      ).resolves.toMatchObject({ asksHqSharingConsent: asks });
    });

    it('가맹 점포 · 더는 받아 주지 않는 문구 버전에 동의했으면 다시 묻는다(ATT-30)', async () => {
      store('FRANCHISE');
      account({ isHqSharingConsented: true, hqSharingConsentVersion: 'v0.9' });
      await expect(
        service().checkForAccount(77, { code: CODE }),
      ).resolves.toMatchObject({ asksHqSharingConsent: true });
    });

    it('링크 토큰은 sha256 으로 찾는다', async () => {
      await service().checkForAccount(77, { token: TOKEN });
      expect(argOf(tx.invitation.findMany).where).toEqual({
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        invitationToken: hashToken(TOKEN),
      });
    });

    it('링크의 초대 번호가 계정 번호와 다르면 없는 초대와 같은 404 — 남의 초대를 잇지 못한다', async () => {
      tx.invitation.findMany.mockResolvedValue([
        invitation({
          staffMember: { ...invitation().staffMember, phone: '01099998888' },
        }),
      ]);
      const e = await thrown(service().checkForAccount(77, { token: TOKEN }));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_NOT_FOUND');
    });

    it.each([
      ['아무것도 없음', {}],
      ['토큰과 코드를 함께', { token: TOKEN, code: CODE }],
    ])('%s — 400', async (_label, lookup) => {
      const e = await thrown(service().checkForAccount(77, lookup));
      expect(e.getStatus()).toBe(400);
    });

    it('계정이 탈퇴했으면 401', async () => {
      account({ status: 'WITHDRAWN' });
      const e = await thrown(service().checkForAccount(77, { code: CODE }));
      expect(e.getStatus()).toBe(401);
    });
  });

  describe('더하기', () => {
    it('초대 수락 · 레코드를 이 계정에 잇기 · 서명 대기, 동의를 보내면 계정에 남긴다', async () => {
      await expect(
        service().acceptForAccount(77, {
          code: CODE,
          hqSharingConsented: true,
        }),
      ).resolves.toEqual({ staffMemberId: 19, storeName: '모리커피 합정점' });
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: 41, status: 'SENT' },
        data: { status: 'ACCEPTED', respondedAt: NOW },
      });
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 77 },
        data: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: NOW,
          hqSharingWithdrawnAt: null,
        },
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 19, accountId: null },
        data: { accountId: 77, joinStatus: 'JOINED', candidateAccountId: null },
      });
      expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith({
        where: { staffMemberId: 19, status: 'PENDING_SEND' },
        data: { status: 'PENDING_SIGNATURE' },
        select: { contractId: true },
      });
    });

    it.each([
      ['직영 점포', 'DIRECT', false, true],
      ['계정이 이미 동의', 'FRANCHISE', true, true],
      ['동의하지 않음', 'FRANCHISE', false, false],
    ])(
      '%s — 계정 동의를 바꾸지 않는다',
      async (_label, type, consented, send) => {
        store(type);
        account({
          isHqSharingConsented: consented,
          hqSharingConsentVersion: 'v1.0',
        });
        await service().acceptForAccount(77, {
          code: CODE,
          hqSharingConsented: send,
        });
        expect(tx.account.update).not.toHaveBeenCalled();
      },
    );

    it('옛 문구 버전에 동의한 계정이 다시 동의를 보내면 지금 버전으로 덮는다(ATT-30)', async () => {
      store('FRANCHISE');
      account({ isHqSharingConsented: true, hqSharingConsentVersion: 'v0.9' });
      await service().acceptForAccount(77, {
        code: CODE,
        hqSharingConsented: true,
      });
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 77 },
        data: expect.objectContaining({
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        }) as unknown,
      });
    });

    it('같은 초대로 먼저 더했으면 409 — 레코드를 잇지 않는다', async () => {
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      const e = await thrown(service().acceptForAccount(77, { code: CODE }));
      expect(codeOf(e)).toBe('INVITATION_ALREADY_JOINED');
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('계정 번호로 잠금을 센다 — 코드가 맞지 않으면 실패로 세고 404, 잠겨 있으면 429', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      const e = await thrown(service().acceptForAccount(77, { code: CODE }));
      expect(e.getStatus()).toBe(404);
      expect(tx.invitationCodeAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isSucceeded: false,
          failedCount: 1,
        }) as object,
      });
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();

      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 5,
        lockExpiresAt: new Date(NOW.getTime() + 60_000),
      });
      const locked = await thrown(
        service().checkForAccount(77, { code: CODE }),
      );
      expect(locked.getStatus()).toBe(429);
    });

    it('링크 토큰은 잠금을 세지 않는다', async () => {
      await service().acceptForAccount(77, { token: TOKEN });
      // 번호 잠금(lockPeople)은 잡지만 코드 시도는 세지 않는다
      expect(tx.invitationCodeAttempt.findFirst).not.toHaveBeenCalled();
      expect(tx.invitationCodeAttempt.create).not.toHaveBeenCalled();
    });

    it('번호부터 잠근다 — 가입 · 재발송과 같은 순서(api #81 리뷰)', async () => {
      await service().acceptForAccount(77, { code: CODE });
      const calls = tx.$executeRaw.mock.calls as unknown[][];
      expect(calls.some((c) => c.includes(`contracts:${PHONE}`))).toBe(true);
    });

    it('번호 → 직원 행 → 초대 · 레코드 순서로 잠근다 — 퇴직 확정과 같은 순서(api #81 3차 리뷰)', async () => {
      await service().acceptForAccount(77, { code: CODE });
      const calls = tx.$executeRaw.mock.calls as unknown[][];
      const people = calls.findIndex((c) => c.includes(`contracts:${PHONE}`));
      const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];
      const staffLock = order(tx.$queryRaw);
      expect(order(tx.$executeRaw, people)).toBeLessThan(staffLock);
      expect(String((tx.$queryRaw.mock.calls[0] as [string[]])[0])).toContain(
        'FOR UPDATE',
      );
      expect(staffLock).toBeLessThan(order(tx.invitation.updateMany));
      expect(staffLock).toBeLessThan(order(tx.staffMember.updateMany));
    });

    it('잠근 뒤 다시 읽은 번호가 바뀌었으면(근로계약 수정) 404 INVITATION_ENDED — 잇지 않는다', async () => {
      tx.$queryRaw.mockResolvedValue([{ phone: '01099998888' }]);
      const e = await thrown(service().acceptForAccount(77, { code: CODE }));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_ENDED');
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 초대가 끝났으면 0건 수락 뒤 404 INVITATION_ENDED', async () => {
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      tx.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
      const e = await thrown(service().acceptForAccount(77, { code: CODE }));
      expect(codeOf(e)).toBe('INVITATION_ENDED');
    });

    it('맞는 초대가 없으면 404', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      const e = await thrown(service().acceptForAccount(77, { code: CODE }));
      expect(codeOf(e)).toBe('INVITATION_NOT_FOUND');
    });
  });
});
