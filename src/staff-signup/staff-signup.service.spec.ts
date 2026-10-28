import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthSessionService } from '../auth-session/auth-session.service';
import type { AccountAuthService } from '../auth/account-auth.service';
import { hashToken } from '../auth/password';
import { hashInvitationCode } from '../contracts/contract-delivery.service';
import type { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import type { StaffSignupDto } from './dto/staff-signup.dto';
import {
  CODE_MISMATCH,
  INVITATION_ENDED,
  StaffSignupService,
  UNDER_AGE,
} from './staff-signup.service';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

// scrypt 는 느리다 — 값만 확인한다. hashToken 은 진짜를 쓴다
jest.mock('../auth/password', () => ({
  ...jest.requireActual<typeof import('../auth/password')>('../auth/password'),
  hashPassword: jest.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
}));
jest.mock('../notifications/recipients', () => ({
  storeManagers: jest.fn().mockResolvedValue([5, 6]),
}));

const SECRET = 'jwt-secret-for-staff-signup-test-0123456789';
const TOKEN = 'A'.repeat(43);
const CODE = 'K7Q2M9PX';
const PHONE = '01012345678';
// 2026-10-20 10:00 KST
const NOW = new Date('2026-10-20T01:00:00.000Z');
const LATER = new Date('2026-11-19T01:00:00.000Z');
const EARLIER = new Date('2026-10-01T01:00:00.000Z');

describe('StaffSignupService', () => {
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    invitationCodeAttempt: { findFirst: jest.Mock; create: jest.Mock };
    invitation: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    store: { findUnique: jest.Mock };
    account: { count: jest.Mock; create: jest.Mock };
    staffMember: { updateMany: jest.Mock };
    contract: { updateManyAndReturn: jest.Mock };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };
  let sessions: { issue: jest.Mock };
  let accountAuth: { loginResponseOf: jest.Mock };
  let ops: { notify: jest.Mock };

  const invitation = (overrides: Record<string, unknown> = {}) => ({
    invitationId: 31,
    status: 'SENT',
    expiresAt: LATER,
    staffMember: {
      staffMemberId: 9,
      storeId: 3,
      name: '홍길동',
      phone: PHONE,
      employmentType: 'PART_TIME',
      accountId: null,
    },
    ...overrides,
  });
  const store = (storeTypeCode = 'DIRECT') =>
    tx.store.findUnique.mockResolvedValue({
      name: '모리커피 연남점',
      storeTypeCode,
    });
  const byCode = { phone: PHONE, code: CODE };
  const input = (overrides: Partial<StaffSignupDto> = {}): StaffSignupDto => ({
    ...byCode,
    email: 'staff@whale.test',
    password: 'Whale2026!',
    name: '홍길동',
    birthDate: '1995-03-02',
    gender: 'MALE',
    isForeigner: false,
    zipCode: '04001',
    address: '서울 마포구 동교로 1',
    addressDetail: '2층',
    deviceIdentifier: 'device-1',
    ...overrides,
  });
  const service = (secret: string | null = SECRET) =>
    new StaffSignupService(
      prisma as unknown as PrismaService,
      sessions as unknown as AuthSessionService,
      accountAuth as unknown as AccountAuthService,
      ops as unknown as OpsNotificationService,
      { get: () => secret ?? undefined } as unknown as ConfigService,
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
  /** 첫 호출의 인자 */
  const argOf = (m: jest.Mock) =>
    (m.mock.calls[0] as [{ where?: unknown; data?: unknown }])[0];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      // 직원 행 잠금 — 잠근 뒤 다시 읽은 번호
      $queryRaw: jest.fn().mockResolvedValue([{ phone: PHONE }]),
      invitationCodeAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      invitation: {
        findMany: jest.fn().mockResolvedValue([invitation()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // 수락이 0건일 때 까닭을 다시 읽는다
        findUnique: jest.fn().mockResolvedValue({ status: 'ACCEPTED' }),
      },
      store: { findUnique: jest.fn() },
      account: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          accountId: 77,
          email: 'staff@whale.test',
          realName: '홍길동',
        }),
      },
      staffMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      contract: {
        updateManyAndReturn: jest.fn().mockResolvedValue([{ contractId: 5 }]),
      },
      contractStatusHistory: {
        createManyAndReturn: jest.fn().mockResolvedValue([]),
      },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    sessions = {
      issue: jest.fn().mockResolvedValue({
        authSessionId: 12,
        refreshToken: 'refresh',
        expiresAt: LATER,
      }),
    };
    accountAuth = {
      loginResponseOf: jest.fn().mockResolvedValue({ accessToken: 'access' }),
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    store();
  });

  afterEach(() => jest.useRealTimers());

  it('JWT_SECRET 이 없으면 만들 수 없다', () => {
    expect(() => service(null)).toThrow('JWT_SECRET');
  });

  describe('초대 확인', () => {
    it('번호 + 코드 — 코드 HMAC 과 그 초대의 직원 레코드 번호가 모두 맞아야 한다', async () => {
      await expect(service().check(byCode)).resolves.toEqual({
        storeName: '모리커피 연남점',
        employmentType: 'PART_TIME',
        expiresAt: LATER,
        phone: PHONE,
        asksHqSharingConsent: false,
      });
      expect(argOf(tx.invitation.findMany).where).toEqual({
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        invitationCodeHash: hashInvitationCode(CODE, SECRET),
        staffMember: { phone: PHONE },
      });
    });

    it('링크 토큰 — sha256 으로 찾고, 화면이 채울 번호는 그 초대의 번호다', async () => {
      await expect(service().check({ token: TOKEN })).resolves.toMatchObject({
        phone: PHONE,
      });
      expect(argOf(tx.invitation.findMany).where).toEqual({
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        invitationToken: hashToken(TOKEN),
      });
    });

    it.each([
      ['아무것도 없음', {}],
      ['토큰과 번호 · 코드를 함께', { token: TOKEN, ...byCode }],
      ['번호만', { phone: PHONE }],
      ['코드만', { code: CODE }],
    ])('%s — 400', async (_label, lookup) => {
      const e = await thrown(service().check(lookup));
      expect(e.getStatus()).toBe(400);
      expect(tx.invitation.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['FRANCHISE', true],
      ['DIRECT', false],
      ['UNKNOWN', true],
    ])('점포 유형 %s — 본사 제공 동의를 묻는가 %s', async (type, asks) => {
      store(type);
      await expect(service().check(byCode)).resolves.toMatchObject({
        asksHqSharingConsent: asks,
      });
    });

    it('번호 · 코드가 맞는 초대가 없으면 404 — 어느 쪽이 틀렸는지 알리지 않는다', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      const e = await thrown(service().check(byCode));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_NOT_FOUND');
      expect(e.message).toBe(CODE_MISMATCH);
    });

    it('토큰이 맞는 초대가 없으면 404 — 끝난 초대와 같은 문구', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      const e = await thrown(service().check({ token: TOKEN }));
      expect(codeOf(e)).toBe('INVITATION_NOT_FOUND');
      expect(e.message).toBe(INVITATION_ENDED);
    });

    it.each([
      [
        '기한이 지났는데 배치가 아직 만료로 바꾸지 않음',
        invitation({ expiresAt: EARLIER }),
      ],
      ['다시 보내 무효', invitation({ status: 'EXPIRED' })],
      ['가입 불가(만 19세 미만)', invitation({ status: 'REJECTED_UNDER_AGE' })],
    ])('%s — 404 INVITATION_ENDED', async (_label, row) => {
      tx.invitation.findMany.mockResolvedValue([row]);
      const e = await thrown(service().check(byCode));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_ENDED');
    });

    it('가입을 마친 초대면 409 INVITATION_ALREADY_JOINED — 로그인으로', async () => {
      tx.invitation.findMany.mockResolvedValue([
        invitation({ status: 'ACCEPTED' }),
      ]);
      const e = await thrown(service().check(byCode));
      expect(e.getStatus()).toBe(409);
      expect(codeOf(e)).toBe('INVITATION_ALREADY_JOINED');
    });

    it('그 번호로 계정이 있으면 409 ACCOUNT_EXISTS — 로그인 뒤 근무지를 더한다', async () => {
      tx.account.count.mockResolvedValue(1);
      const e = await thrown(service().check(byCode));
      expect(codeOf(e)).toBe('ACCOUNT_EXISTS');
      expect(argOf(tx.account.count).where).toEqual({
        phone: PHONE,
        status: { not: 'WITHDRAWN' },
      });
    });
  });

  describe('번호 + 코드 잠금 (JOIN-7)', () => {
    const recorded = () =>
      (tx.invitationCodeAttempt.create.mock.calls as [[{ data: unknown }]]).map(
        ([a]) => a.data,
      );

    it('맞는 초대가 있으면 실패를 지운다 — 같은 번호 키로 줄을 세운다', async () => {
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 3,
        lockExpiresAt: null,
      });
      await service().check(byCode);
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(argOf(tx.invitation.findMany)).toEqual({
        where: {
          invitationType: { in: ['SIGNUP', 'REINVITE'] },
          invitationCodeHash: hashInvitationCode(CODE, SECRET),
          staffMember: { phone: PHONE },
        },
        select: { status: true, expiresAt: true },
      });
      expect(recorded()).toEqual([
        expect.objectContaining({
          isSucceeded: true,
          failedCount: 0,
          lockExpiresAt: null,
        }),
      ]);
    });

    it('맞는 초대가 없으면 실패로 세고 404 — 초대를 찾지 않는다', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 2,
        lockExpiresAt: null,
      });
      const e = await thrown(service().check(byCode));
      expect(e.getStatus()).toBe(404);
      expect(e.message).toBe(CODE_MISMATCH);
      expect(recorded()).toEqual([
        expect.objectContaining({
          isSucceeded: false,
          failedCount: 3,
          lockExpiresAt: null,
        }),
      ]);
      // 잠금 검사의 한 번뿐 — 확인의 초대 조회까지 가지 않는다
      expect(tx.invitation.findMany).toHaveBeenCalledTimes(1);
    });

    it('5번째 실패면 30분 잠그고 429 — 해제 시각을 준다', async () => {
      tx.invitation.findMany.mockResolvedValue([]);
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 4,
        lockExpiresAt: null,
      });
      const e = await thrown(service().check(byCode));
      const until = new Date(NOW.getTime() + 30 * 60_000);
      expect(e.getStatus()).toBe(429);
      expect(e.getResponse()).toMatchObject({
        code: 'INVITATION_CODE_LOCKED',
        lockExpiresAt: until,
      });
      expect(recorded()).toEqual([
        expect.objectContaining({ failedCount: 5, lockExpiresAt: until }),
      ]);
    });

    it('잠긴 동안은 맞는 코드여도 429 — 시도는 남기되 세지 않는다', async () => {
      const until = new Date(NOW.getTime() + 10 * 60_000);
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 5,
        lockExpiresAt: until,
      });
      const e = await thrown(service().signup(input()));
      expect(e.getStatus()).toBe(429);
      expect(recorded()).toEqual([
        expect.objectContaining({
          isSucceeded: false,
          failedCount: 5,
          lockExpiresAt: until,
        }),
      ]);
      expect(tx.invitation.findMany).not.toHaveBeenCalled();
      expect(tx.account.create).not.toHaveBeenCalled();
    });

    it('끝난 옛 코드가 맞으면 세지도 지우지도 않는다 — 실패 횟수를 그대로 남기고 「끝난 초대」로 답한다(api #81 리뷰)', async () => {
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        failedCount: 4,
        lockExpiresAt: null,
      });
      tx.invitation.findMany.mockResolvedValue([
        invitation({ status: 'EXPIRED' }),
      ]);
      const e = await thrown(service().check(byCode));
      expect(codeOf(e)).toBe('INVITATION_ENDED');
      expect(recorded()).toEqual([
        expect.objectContaining({
          isSucceeded: false,
          failedCount: 4,
          lockExpiresAt: null,
        }),
      ]);
    });

    it('링크 토큰은 잠금을 보지 않는다', async () => {
      await service().check({ token: TOKEN });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.invitationCodeAttempt.create).not.toHaveBeenCalled();
    });
  });

  describe('가입', () => {
    it('계정(번호는 초대의 번호) · 레코드 연결 · 초대 수락 · 서명 대기(직원) · 접속 상태', async () => {
      await expect(service().signup(input({ phone: PHONE }))).resolves.toEqual({
        accessToken: 'access',
      });
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: 31, status: 'SENT' },
        data: { status: 'ACCEPTED', respondedAt: NOW },
      });
      expect(argOf(tx.account.create).data).toEqual({
        email: 'staff@whale.test',
        passwordHash: 'hashed:Whale2026!',
        realName: '홍길동',
        birthDate: new Date('1995-03-02T00:00:00.000Z'),
        phone: PHONE,
        gender: 'MALE',
        isForeigner: false,
        zipCode: '04001',
        address: '서울 마포구 동교로 1',
        addressDetail: '2층',
        status: 'JOINED',
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 9, accountId: null },
        data: { accountId: 77, joinStatus: 'JOINED', candidateAccountId: null },
      });
      expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith({
        where: { staffMemberId: 9, status: 'PENDING_SEND' },
        data: { status: 'PENDING_SIGNATURE' },
        select: { contractId: true },
      });
      expect(argOf(tx.contractStatusHistory.createManyAndReturn).data).toEqual([
        {
          contractId: 5,
          fromStatus: 'PENDING_SEND',
          toStatus: 'PENDING_SIGNATURE',
          actor: 'STAFF',
        },
      ]);
      // 접속 상태는 커밋 뒤에 연다
      expect(sessions.issue).toHaveBeenCalledWith({
        accountId: 77,
        deviceIdentifier: 'device-1',
      });
      expect(accountAuth.loginResponseOf).toHaveBeenCalledWith(
        {
          accountId: 77,
          email: 'staff@whale.test',
          realName: '홍길동',
          status: 'JOINED',
        },
        expect.objectContaining({ authSessionId: 12 }),
      );
      expect(ops.notify).not.toHaveBeenCalled();
    });

    it('번호 → 직원 행 → 계정 확인 · 초대 · 계정 만들기 순서로 잠근다 — 재발송 · 퇴직 확정과 같은 순서(api #81 재리뷰)', async () => {
      await service().signup(input());
      const calls = tx.$executeRaw.mock.calls as unknown[][];
      const people = calls.findIndex((c) => c.includes(`contracts:${PHONE}`));
      expect(people).toBeGreaterThanOrEqual(0);
      const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];
      const staffLock = order(tx.$queryRaw);
      expect(order(tx.$executeRaw, people)).toBeLessThan(staffLock);
      expect(String((tx.$queryRaw.mock.calls[0] as [string[]])[0])).toContain(
        'FOR UPDATE',
      );
      expect(staffLock).toBeLessThan(order(tx.account.count));
      expect(staffLock).toBeLessThan(order(tx.invitation.updateMany));
      expect(order(tx.account.count)).toBeLessThan(order(tx.account.create));
    });

    it('잠근 뒤 다시 읽은 번호가 바뀌었으면(근로계약 수정) 404 INVITATION_ENDED — 옛 번호로 잇지 않는다', async () => {
      tx.$queryRaw.mockResolvedValue([{ phone: '01099998888' }]);
      const e = await thrown(service().signup(input()));
      expect(e.getStatus()).toBe(404);
      expect(codeOf(e)).toBe('INVITATION_ENDED');
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.account.create).not.toHaveBeenCalled();
    });

    it('오늘 뒤 생년월일은 400 — 만 19세 미만으로 보고 초대를 끝내지 않는다', async () => {
      const e = await thrown(
        service().signup(input({ birthDate: '2026-10-21' })),
      );
      expect(codeOf(e)).toBe('BIRTH_DATE_IN_FUTURE');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('링크로 와도 계정 번호는 초대의 번호다', async () => {
      await service().signup(
        input({ phone: undefined, code: undefined, token: TOKEN }),
      );
      expect(argOf(tx.account.create).data).toMatchObject({ phone: PHONE });
    });

    it('외국인 여부 · 상세주소를 비우면 내국인 · 상세주소 없음', async () => {
      await service().signup(
        input({ isForeigner: undefined, addressDetail: '' }),
      );
      expect(argOf(tx.account.create).data).toMatchObject({
        gender: 'MALE',
        isForeigner: false,
        addressDetail: null,
      });
    });

    it('가맹 점포에서 본사 제공 동의하면 계정에 버전 · 시각과 함께 남긴다(api #78)', async () => {
      store('FRANCHISE');
      await service().signup(input({ hqSharingConsented: true }));
      expect(argOf(tx.account.create).data).toMatchObject({
        isHqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        hqSharingAgreedAt: NOW,
      });
    });

    it.each([
      ['가맹 점포에서 동의하지 않음', 'FRANCHISE', false],
      ['가맹 점포에서 답하지 않음', 'FRANCHISE', undefined],
      ['직영 점포에서 동의를 보냄', 'DIRECT', true],
    ])('%s — 동의 칸을 채우지 않는다', async (_label, type, consented) => {
      store(type);
      await service().signup(input({ hqSharingConsented: consented }));
      expect(argOf(tx.account.create).data).not.toHaveProperty(
        'isHqSharingConsented',
      );
    });

    it('비밀번호 규칙에 맞지 않으면 400 — 아무것도 쓰지 않는다', async () => {
      const e = await thrown(service().signup(input({ password: 'abcdefgh' })));
      expect(e.getStatus()).toBe(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('가입하는 날(한국 시간) 만 19세 미만이면 계정 없이 초대를 가입 불가로 두고 점포 관리자에게 알린 뒤 400', async () => {
      const e = await thrown(
        service().signup(input({ birthDate: '2007-10-21' })),
      );
      expect(e.getStatus()).toBe(400);
      expect(codeOf(e)).toBe('SIGNUP_UNDER_AGE');
      expect(e.message).toBe(UNDER_AGE);
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: 31, status: 'SENT' },
        data: { status: 'REJECTED_UNDER_AGE', respondedAt: NOW },
      });
      expect(tx.account.create).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(storeManagers).toHaveBeenCalledWith(prisma, 9);
      // 생년월일은 알림에 싣지 않는다
      expect(ops.notify).toHaveBeenCalledWith({
        templateCode: 'NTF_SIGNUP_UNDER_AGE',
        variables: { 직원이름: '홍길동', 근무지: '모리커피 연남점' },
        related: { type: 'STAFF_MEMBER', id: 9 },
        eventKey: 'invitation:31',
        recipients: [5, 6],
      });
    });

    it('생일 당일에 만 19세가 되면 가입한다', async () => {
      await expect(
        service().signup(input({ birthDate: '2007-10-20' })),
      ).resolves.toEqual({ accessToken: 'access' });
    });

    it.each([
      [
        '맞는 초대가 없음',
        () => tx.invitation.findMany.mockResolvedValue([]),
        'INVITATION_NOT_FOUND',
      ],
      [
        '그 번호로 계정이 있음',
        () => tx.account.count.mockResolvedValue(1),
        'ACCOUNT_EXISTS',
      ],
      [
        '같은 초대로 먼저 가입함(0건 수락 · 지금 수락됨)',
        () => tx.invitation.updateMany.mockResolvedValue({ count: 0 }),
        'INVITATION_ALREADY_JOINED',
      ],
      [
        '그사이 재발송 · 퇴직으로 초대가 끝남(0건 수락 · 지금 만료)',
        () => {
          tx.invitation.updateMany.mockResolvedValue({ count: 0 });
          tx.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
        },
        'INVITATION_ENDED',
      ],
    ])('%s — %s, 계정을 만들지 않는다', async (_label, arrange, code) => {
      arrange();
      const e = await thrown(service().signup(input()));
      expect(codeOf(e)).toBe(code);
      expect(tx.account.create).not.toHaveBeenCalled();
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('레코드에 그사이 계정이 이어졌으면 409 — 계약은 그대로', async () => {
      tx.staffMember.updateMany.mockResolvedValue({ count: 0 });
      const e = await thrown(service().signup(input()));
      expect(codeOf(e)).toBe('INVITATION_ALREADY_JOINED');
      expect(tx.contract.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('이메일이 이미 쓰이면(고유 제약) 409 ACCOUNT_EMAIL_TAKEN', async () => {
      tx.account.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      const e = await thrown(service().signup(input()));
      expect(e.getStatus()).toBe(409);
      expect(codeOf(e)).toBe('ACCOUNT_EMAIL_TAKEN');
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });
});
