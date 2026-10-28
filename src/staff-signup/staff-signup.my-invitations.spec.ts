import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthSessionService } from '../auth-session/auth-session.service';
import type { AccountAuthService } from '../auth/account-auth.service';
import type { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { HQ_SHARING_CONSENT_VERSION } from './hq-sharing-consent';
import { InvitationIdPipe } from './invitation-id.pipe';
import { StaffSignupService } from './staff-signup.service';

const SECRET = 'jwt-secret-for-staff-signup-test-0123456789';
const PHONE = '01012345678';
const OTHER_PHONE = '01099998888';
const NOW = new Date('2026-10-20T01:00:00.000Z');
const SENT = new Date('2026-10-19T01:00:00.000Z');
const LATER = new Date('2026-11-19T01:00:00.000Z');

// 로그인 후 내게 온 가입 초대로 근무지 더하기(WHALEERP-603, 2026-10-28 — 코드 · 링크 입력 대신 목록에서 고른다)
describe('StaffSignupService — 로그인 후 근무지 더하기', () => {
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    account: { findUnique: jest.Mock; update: jest.Mock };
    invitation: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    store: { findUnique: jest.Mock; findMany: jest.Mock };
    staffMember: { updateMany: jest.Mock };
    contract: { updateManyAndReturn: jest.Mock };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };

  const staffMember = (overrides: Record<string, unknown> = {}) => ({
    staffMemberId: 19,
    storeId: 4,
    name: '홍길동',
    phone: PHONE,
    employmentType: 'FULL_TIME',
    accountId: null,
    ...overrides,
  });
  const invitation = (
    overrides: Record<string, unknown> = {},
    staff: Record<string, unknown> = {},
  ) => ({
    invitationId: 41,
    invitationType: 'SIGNUP',
    status: 'SENT',
    expiresAt: LATER,
    staffMember: staffMember(staff),
    ...overrides,
  });
  const account = (overrides: Record<string, unknown> = {}) =>
    tx.account.findUnique.mockResolvedValue({
      phone: PHONE,
      // 근로계약서 이름(홍길동)과 공백 · 영문 대소문자만 다르게 둬 같은 이름으로 보는지도 함께 본다
      realName: '홍 길동',
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
  type Arg = { where?: unknown; data?: unknown; orderBy?: unknown };
  const argOf = (m: jest.Mock) => (m.mock.calls[0] as [Arg])[0];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ phone: PHONE }]),
      account: { findUnique: jest.fn(), update: jest.fn() },
      invitation: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(invitation()),
      },
      store: { findUnique: jest.fn(), findMany: jest.fn() },
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

  describe('내 초대 목록', () => {
    const row = (invitationId: number, storeId: number, sentAt = SENT) => ({
      invitationId,
      sentAt,
      expiresAt: LATER,
      staffMember: {
        storeId,
        name: '홍길동',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
      },
    });

    beforeEach(() => {
      tx.store.findMany.mockResolvedValue([
        { storeId: 4, name: '모리커피 합정점', storeTypeCode: 'FRANCHISE' },
        { storeId: 5, name: '모리커피 본점', storeTypeCode: 'DIRECT' },
      ]);
    });

    it('번호가 같아도 근로계약서 이름이 계정 이름과 다르면 목록에 없다 — 번호 재활용 대비(api #180 리뷰)', async () => {
      tx.invitation.findMany.mockResolvedValue([
        row(42, 4),
        {
          ...row(43, 5),
          staffMember: { ...row(43, 5).staffMember, name: '김철수' },
        },
      ]);
      const { items, total } = await service().listForAccount(77);
      expect(items.map((i) => i.invitationId)).toEqual([42]);
      expect(total).toBe(1);
    });

    it('이름이 모두 다르면 점포를 읽지 않고 빈 목록', async () => {
      tx.invitation.findMany.mockResolvedValue([
        {
          ...row(43, 5),
          staffMember: { ...row(43, 5).staffMember, name: '김철수' },
        },
      ]);
      await expect(service().listForAccount(77)).resolves.toEqual({
        items: [],
        total: 0,
      });
      expect(tx.store.findMany).not.toHaveBeenCalled();
    });

    it('계정 번호로 온 살아 있는 가입 초대만, 보낸 때 최근 순으로 읽는다', async () => {
      await service().listForAccount(77);
      expect(argOf(tx.account.findUnique).where).toEqual({ accountId: 77 });
      expect(argOf(tx.invitation.findMany).where).toEqual({
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        status: 'SENT',
        expiresAt: { gt: NOW },
        staffMember: { phone: PHONE, accountId: null },
      });
      expect(argOf(tx.invitation.findMany).orderBy).toEqual([
        { sentAt: 'desc' },
        { invitationId: 'desc' },
      ]);
    });

    it('초대마다 근무지 · 고용 형태 · 직무 · 보낸 때 · 끝나는 때 · 동의를 물을지 — 점포를 찾지 못한 초대는 뺀다', async () => {
      const later = new Date('2026-10-19T05:00:00.000Z');
      tx.invitation.findMany.mockResolvedValue([
        row(43, 5, later),
        row(42, 4),
        row(44, 99),
      ]);
      await expect(service().listForAccount(77)).resolves.toEqual({
        items: [
          {
            invitationId: 43,
            storeName: '모리커피 본점',
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            sentAt: later,
            expiresAt: LATER,
            asksHqSharingConsent: false,
          },
          {
            invitationId: 42,
            storeName: '모리커피 합정점',
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            sentAt: SENT,
            expiresAt: LATER,
            asksHqSharingConsent: true,
          },
        ],
        total: 2,
      });
      expect(argOf(tx.store.findMany).where).toEqual({
        storeId: { in: [5, 4, 99] },
      });
    });

    it('계정이 이미 본사 제공 동의를 했으면 가맹점이어도 묻지 않는다', async () => {
      account({ isHqSharingConsented: true });
      tx.invitation.findMany.mockResolvedValue([row(42, 4)]);
      const { items } = await service().listForAccount(77);
      expect(items[0].asksHqSharingConsent).toBe(false);
    });

    it('초대가 없으면 빈 목록 — 점포를 읽지 않는다', async () => {
      await expect(service().listForAccount(77)).resolves.toEqual({
        items: [],
        total: 0,
      });
      expect(tx.store.findMany).not.toHaveBeenCalled();
    });

    it('계정이 탈퇴했거나 없으면 401', async () => {
      account({ status: 'WITHDRAWN' });
      expect((await thrown(service().listForAccount(77))).getStatus()).toBe(
        401,
      );
      tx.account.findUnique.mockResolvedValue(null);
      expect((await thrown(service().listForAccount(77))).getStatus()).toBe(
        401,
      );
    });
  });

  describe('더하기', () => {
    it('초대 id 로 찾아 수락 · 레코드를 이 계정에 잇기 · 서명 대기, 동의를 보내면 계정에 남긴다', async () => {
      await expect(
        service().acceptForAccount(77, 41, { hqSharingConsented: true }),
      ).resolves.toEqual({ staffMemberId: 19, storeName: '모리커피 합정점' });
      expect(argOf(tx.invitation.findUnique).where).toEqual({
        invitationId: 41,
      });
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

    it('재초대도 더할 수 있다', async () => {
      tx.invitation.findUnique.mockResolvedValue(
        invitation({ invitationType: 'REINVITE' }),
      );
      await expect(service().acceptForAccount(77, 41, {})).resolves.toEqual({
        staffMemberId: 19,
        storeName: '모리커피 합정점',
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
        account({ isHqSharingConsented: consented });
        await service().acceptForAccount(77, 41, { hqSharingConsented: send });
        expect(tx.account.update).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['없는 초대', null],
      [
        '가입 초대가 아님(소속 추가 확인)',
        invitation({ invitationType: 'AFFILIATION_CONFIRM' }),
      ],
      ['남의 번호로 온 초대', invitation({}, { phone: OTHER_PHONE })],
      [
        '남의 번호로 온, 이미 수락된 초대',
        invitation(
          { status: 'ACCEPTED' },
          { phone: OTHER_PHONE, accountId: 5 },
        ),
      ],
      [
        '남의 번호로 온, 끝난 초대',
        invitation({ status: 'EXPIRED' }, { phone: OTHER_PHONE }),
      ],
      [
        '같은 번호지만 근로계약서 이름이 다른 초대(번호 재활용)',
        invitation({}, { name: '김철수' }),
      ],
      [
        '같은 번호 · 다른 이름, 이미 수락된 초대',
        invitation({ status: 'ACCEPTED' }, { name: '김철수', accountId: 5 }),
      ],
    ])(
      '%s — 404 INVITATION_NOT_FOUND, 상태를 드러내지 않고 잇지 않는다',
      async (_label, found) => {
        tx.invitation.findUnique.mockResolvedValue(found);
        const e = await thrown(service().acceptForAccount(77, 41, {}));
        expect(e.getStatus()).toBe(404);
        expect(codeOf(e)).toBe('INVITATION_NOT_FOUND');
        expect(tx.invitation.updateMany).not.toHaveBeenCalled();
        expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
      },
    );

    it('내 초대가 이미 수락됐으면 409 INVITATION_ALREADY_JOINED', async () => {
      tx.invitation.findUnique.mockResolvedValue(
        invitation({ status: 'ACCEPTED' }, { accountId: 77 }),
      );
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(e.getStatus()).toBe(409);
      expect(codeOf(e)).toBe('INVITATION_ALREADY_JOINED');
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['기한이 지남', invitation({ expiresAt: NOW })],
      ['만료로 바뀜', invitation({ status: 'EXPIRED' })],
      ['가입 불가', invitation({ status: 'REJECTED_UNDER_AGE' })],
      ['레코드에 이미 계정이 있음', invitation({}, { accountId: 5 })],
    ])('%s — 404 INVITATION_ENDED', async (_label, found) => {
      tx.invitation.findUnique.mockResolvedValue(found);
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_ENDED');
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
    });

    it('점포를 찾지 못하면 404 INVITATION_ENDED', async () => {
      tx.store.findUnique.mockResolvedValue(null);
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(codeOf(e)).toBe('INVITATION_ENDED');
    });

    it('같은 초대로 먼저 더했으면 409 — 레코드를 잇지 않는다', async () => {
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      tx.invitation.findUnique
        .mockResolvedValueOnce(invitation())
        .mockResolvedValueOnce({ status: 'ACCEPTED' });
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(codeOf(e)).toBe('INVITATION_ALREADY_JOINED');
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 초대가 끝났으면 0건 수락 뒤 404 INVITATION_ENDED', async () => {
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      tx.invitation.findUnique
        .mockResolvedValueOnce(invitation())
        .mockResolvedValueOnce({ status: 'EXPIRED' });
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(codeOf(e)).toBe('INVITATION_ENDED');
    });

    it('번호부터 잠근다 — 가입 · 재발송과 같은 순서(api #81 리뷰)', async () => {
      await service().acceptForAccount(77, 41, {});
      const calls = tx.$executeRaw.mock.calls as unknown[][];
      expect(calls.some((c) => c.includes(`contracts:${PHONE}`))).toBe(true);
    });

    it('번호 → 직원 행 → 초대 · 레코드 순서로 잠근다 — 퇴직 확정과 같은 순서(api #81 3차 리뷰)', async () => {
      await service().acceptForAccount(77, 41, {});
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
      tx.$queryRaw.mockResolvedValue([{ phone: OTHER_PHONE }]);
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_ENDED');
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('계정이 탈퇴했으면 401', async () => {
      account({ status: 'WITHDRAWN' });
      const e = await thrown(service().acceptForAccount(77, 41, {}));
      expect(e.getStatus()).toBe(401);
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe('InvitationIdPipe', () => {
  const pipe = new InvitationIdPipe();

  it('integer 범위 안의 숫자만', () => {
    expect(pipe.transform('41')).toBe(41);
    expect(pipe.transform('2147483647')).toBe(2147483647);
  });

  it.each(['0', '2147483648', 'abc', '-1', '1.5'])(
    '%p — DB 에 묻기 전에 404 INVITATION_NOT_FOUND',
    (raw) => {
      let error: HttpException | undefined;
      try {
        pipe.transform(raw);
      } catch (e) {
        error = e as HttpException;
      }
      expect(error?.getStatus()).toBe(404);
      expect((error?.getResponse() as { code?: string }).code).toBe(
        'INVITATION_NOT_FOUND',
      );
    },
  );
});
