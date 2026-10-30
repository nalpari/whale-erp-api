import {
  BadGatewayException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ALIMTALK_BUTTON_NAMES } from '../alimtalk/alimtalk-buttons';
import { AlimtalkService } from '../alimtalk/alimtalk.service';
import { BizppurioError } from '../alimtalk/bizppurio.client';
import { noticeStaff } from '../notifications/staff-notice';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../auth/password';
import { invitationCodePhoneKeyOf } from '../auth/phone-key';
import {
  channelOf,
  ContractDeliveryService,
  deliveredStatusOf,
  type DeliveryInput,
  hashInvitationCode,
  INVITATION_CODE_CHARS,
  newInvitationCode,
  newInvitationToken,
  type PendingInvite,
  restoredStatusOf,
  SEND_VALID_MS,
} from './contract-delivery.service';

// 직원 알림은 staff-notice.spec.ts 가 본다 — 여기서는 부르는지만 본다
jest.mock('../notifications/staff-notice', () => ({
  noticeStaff: jest.fn().mockResolvedValue(true),
}));

// 근로계약 보내기(WHALEERP-136, 2026-10-19 재영 정정 — 저장하면 곧바로 보낸다). 알림톡은 커밋 뒤에
describe('ContractDeliveryService', () => {
  const NOW = new Date('2026-10-19T01:00:00Z');
  const DEADLINE = new Date(NOW.getTime() + SEND_VALID_MS);
  const PHONE = '01090145563';
  const input = (over: Partial<DeliveryInput> = {}): DeliveryInput => ({
    contractId: 7,
    storeId: 11,
    phone: PHONE,
    joined: false,
    draftAction: 'SIGNUP_INVITE',
    before: {
      status: null,
      sentAt: null,
      signDeadlineAt: null,
      draftAction: null,
      staffMemberId: 3,
      staffMember: { joinStatus: 'DRAFT', candidateAccountId: null },
    },
    statusChanged: true,
    phoneChanged: false,
    replacedContracts: false,
    ...over,
  });

  let tx: {
    $executeRaw: jest.Mock;
    contract: {
      update: jest.Mock<Promise<unknown>, [Prisma.ContractUpdateArgs]>;
      findUnique: jest.Mock;
    };
    contractStatusHistory: {
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      create: jest.Mock;
    };
    staffMember: {
      update: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    store: { findUnique: jest.Mock };
    notificationTemplate: { findUnique: jest.Mock };
    invitation: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock<Promise<unknown>, [Prisma.InvitationCreateArgs]>;
      delete: jest.Mock;
    };
    invitationCodeAttempt: {
      create: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let prisma: {
    $transaction: jest.Mock;
    invitation: { findUnique: jest.Mock };
  };
  let alimtalk: { send: jest.Mock; hasSmsFallback: jest.Mock };
  let appUrl: string | undefined;
  const SECRET = 'jwt-secret-for-invitation-code-test-0123456789';

  const service = () =>
    new ContractDeliveryService(
      prisma as unknown as PrismaService,
      alimtalk as unknown as AlimtalkService,
      {
        get: (key: string) => (key === 'JWT_SECRET' ? SECRET : appUrl),
      } as unknown as ConfigService,
    );
  const t = () => tx as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    appUrl = 'https://staff.whale.test/some/path';
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        update: jest.fn<Promise<unknown>, [Prisma.ContractUpdateArgs]>(),
        // 되돌릴 때 읽는 계약 — 기본은 이 요청이 보낸 발송 대기
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'PENDING_SEND', sentAt: NOW }),
      },
      contractStatusHistory: {
        findFirst: jest.fn().mockResolvedValue({ contractStatusHistoryId: 77 }),
        update: jest.fn(),
        delete: jest.fn(),
        create: jest.fn(),
      },
      staffMember: {
        update: jest.fn(),
        updateMany: jest.fn(),
        // 앱으로 받는 직원의 계정(근로계약서 발송 알림)
        findUnique: jest
          .fn()
          .mockResolvedValue({ accountId: 5, account: { status: 'JOINED' } }),
      },
      store: {
        findUnique: jest.fn().mockResolvedValue({ name: '모리커피 연남점' }),
      },
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          channel: 'ALIMTALK',
          title: null,
          body: '…',
          variables: [],
          kakaoTemplateCode: 'WHALE_INVITE_01',
        }),
      },
      invitation: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        // 되돌릴 때 읽는 내 초대 — 기본은 아직 보냄
        findUnique: jest.fn().mockResolvedValue({ status: 'SENT' }),
        updateMany: jest.fn(),
        create: jest
          .fn<Promise<unknown>, [Prisma.InvitationCreateArgs]>()
          .mockResolvedValue({ invitationId: 50 }),
        delete: jest.fn(),
      },
      invitationCodeAttempt: {
        create: jest.fn().mockResolvedValue({ invitationCodeAttemptId: 900 }),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn(),
      },
    };
    prisma = {
      $transaction: jest.fn((work: (x: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
      // 보내기 직전에 다시 읽는 내 초대 — 기본은 아직 보냄
      invitation: {
        findUnique: jest.fn().mockResolvedValue({ status: 'SENT' }),
      },
    };
    alimtalk = {
      send: jest.fn().mockResolvedValue({ referenceKey: 'r' }),
      hasSmsFallback: jest.fn().mockReturnValue(true),
    };
  });

  describe('초대 코드 · 링크 토큰 (JOIN-7, 2026-10-19 재영)', () => {
    it('대문자 · 숫자 8자리, 0 · O · 1 · I 는 없다 — 나머지 글자는 모두 쓰인다', () => {
      expect(INVITATION_CODE_CHARS).toHaveLength(32);
      expect(INVITATION_CODE_CHARS).not.toMatch(/[0O1I]/);
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        const code = newInvitationCode();
        expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
        for (const ch of code) seen.add(ch);
      }
      expect([...seen].sort().join('')).toBe(
        [...INVITATION_CODE_CHARS].sort().join(''),
      );
    });

    it('코드 저장 값은 비밀값을 섞은 HMAC — 입력은 대문자로 맞추고, 비밀값이 다르면 다른 값이다', () => {
      const stored = hashInvitationCode('K7Q2M9PX', SECRET);
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(hashInvitationCode(' k7q2m9px ', SECRET)).toBe(stored);
      expect(hashInvitationCode('K7Q2M9PX', 'other-secret')).not.toBe(stored);
    });

    it('링크 토큰은 32바이트(base64url 43자), 저장 값은 sha256', () => {
      const { token, stored } = newInvitationToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stored).toBe(hashToken(token));
      expect(newInvitationToken().token).not.toBe(token);
    });

    it('JWT_SECRET 이 없으면 만들 수 없다', () => {
      expect(
        () =>
          new ContractDeliveryService(
            prisma as unknown as PrismaService,
            alimtalk as unknown as AlimtalkService,
            { get: () => undefined } as unknown as ConfigService,
          ),
      ).toThrow('JWT_SECRET');
    });
  });

  describe('받을 길 · 보낸 뒤 상태', () => {
    it('가입 전이고 계정이 없으면 가입 초대, 계정이 있으면 소속 추가 확인 요청(둘 다 발송 대기), 가입했으면 앱(서명 대기)', () => {
      expect(channelOf(false, 'SIGNUP_INVITE')).toBe('INVITE');
      expect(deliveredStatusOf(false, 'SIGNUP_INVITE')).toBe('PENDING_SEND');
      // 수락하면 서명 대기다(WHALEERP-130, 2026-10-26 재영)
      for (const action of ['AFFILIATION_CONFIRM', 'RETURN_CONFIRM'] as const) {
        expect(channelOf(false, action)).toBe('AFFILIATION');
        expect(deliveredStatusOf(false, action)).toBe('PENDING_SEND');
        expect(deliveredStatusOf(true, action)).toBe('PENDING_SIGNATURE');
      }
      // 판별값이 없는 옛 계약의 가입 전 직원은 앱 — 받을 계정이 없어 아무것도 나가지 않는다
      expect(channelOf(false, null)).toBe('APP');
      expect(deliveredStatusOf(true, 'SIGNUP_INVITE')).toBe(
        'PENDING_SIGNATURE',
      );
    });
  });

  describe('prepare', () => {
    it('가입 초대 — 서명 기한 30일 · 초대(토큰은 해시로만) · 직원 초대 발송, 이 저장의 이력 줄을 기억한다', async () => {
      const pending = await service().prepare(t(), input(), NOW);
      expect(tx.contract.update).toHaveBeenCalledWith({
        where: { contractId: 7 },
        select: { employmentType: true, jobTitle: true },
        data: {
          sentAt: NOW,
          signDeadlineAt: DEADLINE,
          draftAction: 'SIGNUP_INVITE',
        },
      });
      const [created] = tx.invitation.create.mock.calls[0];
      expect(created.data).toMatchObject({
        staffMemberId: 3,
        invitationType: 'SIGNUP',
        channel: 'ALIMTALK',
        sentAt: NOW,
        expiresAt: DEADLINE,
        status: 'SENT',
      });
      expect(tx.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 3 },
        data: { joinStatus: 'INVITED', candidateAccountId: null },
      });
      expect(pending).toMatchObject({
        invitationId: 50,
        historyId: 77,
        storeName: '모리커피 연남점',
        expired: [],
      });
      // 코드는 JWT_SECRET 을 섞은 HMAC 만, 링크 토큰은 sha256 만 — 원문은 DB 에 없다
      expect(pending!.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(created.data.invitationCodeHash).toBe(
        hashInvitationCode(pending!.code!, SECRET),
      );
      expect(created.data.invitationToken).toBe(hashToken(pending!.token!));
      expect(created.data.invitationToken).not.toContain(pending!.token!);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('가입 초대를 보내면 그 번호의 초대 코드 입력 잠금을 푼다 — 실패 0 행, 해제 · 성공 표시(JOIN-7, api #81 4차 리뷰)', async () => {
      await service().prepare(t(), input(), NOW);
      const phoneKey = invitationCodePhoneKeyOf(SECRET, PHONE);
      expect(tx.invitationCodeAttempt.create).toHaveBeenCalledWith({
        data: {
          phoneKey,
          isSucceeded: true,
          failedCount: 0,
          lockExpiresAt: null,
          attemptedAt: NOW,
        },
        select: { invitationCodeAttemptId: true },
      });
      // 입력 쪽과 같은 번호 키로 줄을 선다(api #81 리뷰)
      expect(tx.$executeRaw).toHaveBeenCalledWith(expect.anything(), phoneKey);
    });

    it('앞서 나간 초대는 모두 무효로 하고 재초대한다 — 상태를 바꾸지 않았으면 이력 줄도 없다', async () => {
      tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
      tx.invitation.count.mockResolvedValue(1);
      const pending = await service().prepare(
        t(),
        input({ statusChanged: false }),
        NOW,
      );
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: { in: [40] } },
        data: { status: 'EXPIRED' },
      });
      expect(tx.invitation.create.mock.calls[0][0].data).toMatchObject({
        invitationType: 'REINVITE',
      });
      expect(pending).toMatchObject({ historyId: null, expired: [40] });
      expect(tx.contractStatusHistory.findFirst).not.toHaveBeenCalled();
    });

    it.each([['가입한 직원', { joined: true }]])(
      '%s 은 앱으로 받는다 — 기한만 잡고 앞 초대는 무효, 보낼 것은 없다(설정이 없어도)',
      async (_, over) => {
        appUrl = undefined;
        tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
        const pending = await service().prepare(t(), input(over), NOW);
        expect(pending).toBeNull();
        expect(tx.contract.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              signDeadlineAt: DEADLINE,
            }) as object,
          }),
        );
        expect(tx.invitation.updateMany).toHaveBeenCalled();
        expect(tx.invitation.create).not.toHaveBeenCalled();
        expect(tx.staffMember.update).not.toHaveBeenCalled();
        // 앱으로 받는 직원은 초대 코드가 없어 잠금도 건드리지 않는다
        expect(tx.invitationCodeAttempt.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['소속 추가 확인', 'AFFILIATION_CONFIRM' as const],
      ['복귀 확인', 'RETURN_CONFIRM' as const],
    ])(
      '계정이 있는 번호(%s)는 소속 추가 확인 요청 — 날인 기한 없이 요청(30일)을 만들고 후보 계정은 두며 커밋 뒤 알림톡 · 메일을 보낸다',
      async (_, draftAction) => {
        tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
        tx.staffMember.update.mockResolvedValue({
          // 입력한 이름과 계정 실명이 공백만 다르다 — 같은 사람으로 보고 메일을 보낸다(본인 대조 규칙)
          name: '남 도현',
          employmentType: 'PART_TIME',
          candidateAccountId: 5,
        });
        tx.store.findUnique.mockResolvedValue({
          name: '모리커피 연남점',
          bpCode: { tradeName: '모리커피' },
        });
        Object.assign(tx, {
          account: {
            findUnique: jest
              .fn()
              .mockResolvedValue({ email: 'a@b.c', realName: '남도현' }),
          },
        });
        const pending = await service().prepare(
          t(),
          input({ draftAction }),
          NOW,
        );
        // 날인 기한은 직원이 수락한 때부터 센다 — 보낼 때는 두지 않는다(만료 배치는 서명 대기만 본다)
        expect(tx.contract.update).toHaveBeenCalledWith({
          where: { contractId: 7 },
          // 알릴 고용 형태를 같은 쓰기에서 돌려받는다 — 따로 읽지 않는다
          select: { employmentType: true, jobTitle: true },
          data: { sentAt: NOW, signDeadlineAt: null, draftAction },
        });
        expect(tx.invitation.create.mock.calls[0][0].data).toEqual({
          staffMemberId: 3,
          invitationType: draftAction,
          channel: 'ALIMTALK',
          sentAt: NOW,
          expiresAt: DEADLINE,
          status: 'SENT',
        });
        // 후보 계정은 저장의 판별이 남긴 값 그대로 — 초대 발송으로만 둔다
        expect(
          (tx.staffMember.update.mock.calls as unknown[][])[0][0],
        ).toMatchObject({
          data: { joinStatus: 'INVITED' },
        });
        // 코드가 없어 잠금 해제 행도 없다
        expect(tx.invitationCodeAttempt.create).not.toHaveBeenCalled();
        expect(pending).toMatchObject({
          kind: 'AFFILIATION',
          code: null,
          token: null,
          unlockAttemptId: null,
          expired: [40],
          storeName: '모리커피 연남점',
          affiliation: {
            bpName: '모리커피',
            employmentType: '파트타이머',
            email: 'a@b.c',
            nameMismatch: false,
          },
        });

        const mail = { send: jest.fn().mockResolvedValue({}) };
        prisma.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
        await new ContractDeliveryService(
          prisma as unknown as PrismaService,
          alimtalk as unknown as AlimtalkService,
          {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : appUrl),
          } as unknown as ConfigService,
          mail as never,
        ).dispatch(pending, 1);
        const variables = {
          사업자: '모리커피',
          근무지: '모리커피 연남점',
          고용형태: '파트타이머',
          링크: 'https://staff.whale.test/affiliations',
        };
        expect(alimtalk.send).toHaveBeenCalledWith({
          templateCode: 'TALK_STAFF_AFFILIATION_REQUEST',
          to: PHONE,
          variables,
          related: { type: 'contract', id: 7 },
          sentBy: 1,
        });
        expect(mail.send).toHaveBeenCalledWith({
          templateCode: 'EMAIL_STAFF_AFFILIATION_REQUEST',
          to: 'a@b.c',
          variables,
        });
      },
    );

    it('입력한 이름이 그 번호 계정의 실명과 다르면 메일은 보내지 않고 알림톡만 입력한 번호로 보낸다 — 받지 못하면 관리자가 유선 확인(WHALEERP-140)', async () => {
      tx.staffMember.update.mockResolvedValue({
        name: '김철수',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        candidateAccountId: 5,
      });
      tx.store.findUnique.mockResolvedValue({
        name: '모리커피 연남점',
        bpCode: { tradeName: '모리커피' },
      });
      Object.assign(tx, {
        account: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ email: 'a@b.c', realName: '남도현' }),
        },
      });
      const pending = await service().prepare(
        t(),
        input({ draftAction: 'AFFILIATION_CONFIRM' }),
        NOW,
      );
      expect(pending?.affiliation).toMatchObject({ nameMismatch: true });
      prisma.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      const mail = { send: jest.fn().mockResolvedValue({}) };
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        await new ContractDeliveryService(
          prisma as unknown as PrismaService,
          alimtalk as unknown as AlimtalkService,
          {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : appUrl),
          } as unknown as ConfigService,
          mail as never,
        ).dispatch(pending, 1);
        expect(alimtalk.send).toHaveBeenCalledWith(
          expect.objectContaining({
            templateCode: 'TALK_STAFF_AFFILIATION_REQUEST',
            to: PHONE,
          }),
        );
        expect(mail.send).not.toHaveBeenCalled();
        // 유선 확인 때 근거가 되는 로그 — 계약 id 와 사유만(이름 · 주소는 남기지 않는다)
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('name differs from the account'),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('알림톡 · 메일의 고용 형태는 이 계약의 것이다 — 레코드가 옛 조건(복귀 확인 · 재계약)이어도(api #164 code-review)', async () => {
      tx.staffMember.update.mockResolvedValue({
        name: '남도현',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        candidateAccountId: 5,
      });
      tx.contract.update.mockResolvedValue({
        employmentType: 'FULL_TIME',
        jobTitle: '매니저',
      });
      tx.store.findUnique.mockResolvedValue({
        name: '모리커피 연남점',
        bpCode: { tradeName: '모리커피' },
      });
      Object.assign(tx, {
        account: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ email: 'a@b.c', realName: '남도현' }),
        },
      });
      const pending = await service().prepare(
        t(),
        input({ draftAction: 'RETURN_CONFIRM' }),
        NOW,
      );
      expect(pending?.affiliation?.employmentType).toBe('정직원');
      prisma.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      const mail = { send: jest.fn().mockResolvedValue({}) };
      await new ContractDeliveryService(
        prisma as unknown as PrismaService,
        alimtalk as unknown as AlimtalkService,
        {
          get: (key: string) => (key === 'JWT_SECRET' ? SECRET : appUrl),
        } as unknown as ConfigService,
        mail as never,
      ).dispatch(pending, 1);
      const withContractTerms = expect.objectContaining({
        variables: expect.objectContaining({ 고용형태: '정직원' }) as object,
      }) as object;
      expect(alimtalk.send).toHaveBeenCalledWith(withContractTerms);
      expect(mail.send).toHaveBeenCalledWith(withContractTerms);
    });

    it('소속 추가 확인 요청 메일이 실패해도 저장 · 응답은 그대로다(알림톡은 나갔다)', async () => {
      const mail = { send: jest.fn().mockRejectedValue(new Error('smtp')) };
      prisma.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      await expect(
        new ContractDeliveryService(
          prisma as unknown as PrismaService,
          alimtalk as unknown as AlimtalkService,
          {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : appUrl),
          } as unknown as ConfigService,
          mail as never,
        ).dispatch(
          {
            ...input({ draftAction: 'AFFILIATION_CONFIRM' }),
            kind: 'AFFILIATION',
            code: null,
            token: null,
            invitationId: 50,
            unlockAttemptId: null,
            affiliation: {
              bpName: 'B',
              employmentType: '정직원',
              email: 'a@b.c',
              nameMismatch: false,
            },
            historyId: null,
            expired: [],
            storeName: 'S',
            now: NOW,
          },
          1,
        ),
      ).resolves.toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('affiliation request mail FAILED'),
      );
      error.mockRestore();
    });

    it('가입한 직원에게는 근로계약서 발송 직원 알림을 만든다 — 근무지 · 날인 기한(한국 날짜), 가입 전 직원은 만들지 않는다', async () => {
      const notice = noticeStaff as jest.Mock;
      notice.mockClear();
      await service().prepare(t(), input({ joined: true }), NOW);
      expect(notice).toHaveBeenCalledTimes(1);
      const [, , arg] = notice.mock.calls[0] as [
        unknown,
        unknown,
        { variables: Record<string, string> },
      ];
      const kst = new Date(DEADLINE.getTime() + 9 * 60 * 60 * 1000);
      expect(arg).toEqual({
        templateCode: 'PUSH_CONTRACT_SENT',
        accountId: 5,
        relatedType: 'CONTRACT',
        relatedId: input({ joined: true }).contractId,
        variables: {
          근무지: '모리커피 연남점',
          날인기한: `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`,
        },
      });

      notice.mockClear();
      await service().prepare(t(), input({ draftAction: null }), NOW);
      expect(notice).not.toHaveBeenCalled();

      // 계정이 없거나 탈퇴했으면 만들지 않는다
      tx.staffMember.findUnique.mockResolvedValue({
        accountId: 5,
        account: { status: 'WITHDRAWN' },
      });
      await service().prepare(t(), input({ joined: true }), NOW);
      expect(notice).not.toHaveBeenCalled();
    });

    it('받을 계정이 없으면(가입했는데 계정 없음 — 데이터 손상) error, 탈퇴 계정이면 warn 으로 남기고 알림 없이 기한만 새로', async () => {
      const notice = noticeStaff as jest.Mock;
      notice.mockClear();
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        tx.staffMember.findUnique.mockResolvedValue({
          accountId: null,
          account: null,
        });
        expect(
          await service().prepare(t(), input({ joined: true }), NOW),
        ).toBeNull();
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('no account'),
        );
        expect(warn).not.toHaveBeenCalled();

        error.mockClear();
        tx.staffMember.findUnique.mockResolvedValue({
          accountId: 5,
          account: { status: 'WITHDRAWN' },
        });
        expect(
          await service().prepare(t(), input({ joined: true }), NOW),
        ).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('withdrawn account'),
        );
        expect(error).not.toHaveBeenCalled();
        expect(notice).not.toHaveBeenCalled();
        // 기한은 그대로 새로 잡는다
        expect(tx.contract.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              signDeadlineAt: DEADLINE,
            }) as unknown,
          }),
        );
      } finally {
        error.mockRestore();
        warn.mockRestore();
      }
    });

    it('근로계약서 발송 알림 템플릿이 꺼져 있으면 알림 없이 보내기는 그대로다(재발송 200) — noticeStaff 가 건너뛴다', async () => {
      const notice = noticeStaff as jest.Mock;
      const actual = jest.requireActual<
        typeof import('../notifications/staff-notice')
      >('../notifications/staff-notice');
      notice.mockClear();
      notice.mockImplementationOnce(actual.noticeStaff);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const create = jest.fn();
      try {
        tx.notificationTemplate.findUnique.mockResolvedValue({
          isActive: false,
          channel: 'PUSH',
          title: '근로계약서가 도착했습니다',
          body: '…',
          variables: [],
        });
        const db = { ...t(), notification: { create } };
        expect(
          await service().prepare(
            db as unknown as Prisma.TransactionClient,
            input({ joined: true }),
            NOW,
          ),
        ).toBeNull();
        expect(await (notice.mock.results[0].value as Promise<boolean>)).toBe(
          false,
        );
        expect(create).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('inactive'));
      } finally {
        warn.mockRestore();
      }
    });

    it('버튼 링크가 있는데 그 템플릿 코드의 버튼 이름이 없으면 쓰기 전에 503(api #219)', async () => {
      const names = ALIMTALK_BUTTON_NAMES as Record<string, string>;
      const saved = names.TALK_STAFF_INVITATION;
      delete names.TALK_STAFF_INVITATION;
      try {
        tx.notificationTemplate.findUnique.mockResolvedValue({
          isActive: true,
          channel: 'ALIMTALK',
          title: null,
          body: '…',
          variables: [{ name: '링크', isButtonLink: true }],
          kakaoTemplateCode: 'WHALE_INVITE_01',
        });
        await expect(service().prepare(t(), input(), NOW)).rejects.toThrow(
          '가입 초대 알림톡 버튼 설정이 맞지 않아 보낼 수 없습니다.',
        );
        expect(tx.invitation.updateMany).not.toHaveBeenCalled();
        expect(tx.contract.update).not.toHaveBeenCalled();
      } finally {
        names.TALK_STAFF_INVITATION = saved;
      }
    });

    it.each<[string, () => void, unknown, string | undefined]>([
      [
        '직원 앱 주소가 없으면 503',
        () => (appUrl = undefined),
        ServiceUnavailableException,
        undefined,
      ],
      [
        '대체 문자 발신번호가 없으면 503 — 링크가 닿을 길이 없다',
        () => alimtalk.hasSmsFallback.mockReturnValue(false),
        ServiceUnavailableException,
        undefined,
      ],
      [
        '가입 초대 템플릿이 꺼져 있으면 503',
        () =>
          tx.notificationTemplate.findUnique.mockResolvedValue({
            isActive: false,
            channel: 'ALIMTALK',
          }),
        ServiceUnavailableException,
        undefined,
      ],
      [
        '가입 초대 템플릿의 버튼 설정이 맞지 않으면(버튼 링크 둘) 503 — 커밋 뒤 발송이 늘 던진다(api #219)',
        () =>
          tx.notificationTemplate.findUnique.mockResolvedValue({
            isActive: true,
            channel: 'ALIMTALK',
            title: null,
            body: '…',
            variables: [
              { name: '링크', isButtonLink: true },
              { name: '링크2', isButtonLink: true },
            ],
            kakaoTemplateCode: 'WHALE_INVITE_01',
          }),
        ServiceUnavailableException,
        undefined,
      ],
      [
        '유선번호면 409 SEND_PHONE_NOT_MOBILE',
        () => {},
        ConflictException,
        '0212345678',
      ],
    ])(
      '가입 초대를 보낼 수 없으면 쓰기 전에 막는다 — %s',
      async (_, arrange, type, phone) => {
        arrange();
        const error = await service()
          .prepare(t(), input(phone ? { phone } : {}), NOW)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(type);
        if (phone)
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'SEND_PHONE_NOT_MOBILE',
          });
        expect(tx.invitation.updateMany).not.toHaveBeenCalled();
        expect(tx.contract.update).not.toHaveBeenCalled();
      },
    );
  });

  const pending = (over: Partial<PendingInvite> = {}): PendingInvite => ({
    ...input(),
    kind: 'INVITE',
    code: 'K7Q2M9PX',
    token: 'tok-123',
    invitationId: 50,
    unlockAttemptId: 900,
    affiliation: null,
    historyId: 77,
    expired: [],
    storeName: '모리커피 연남점',
    now: NOW,
    ...over,
  });

  describe('dispatch', () => {
    it('보낼 것이 없으면(앱으로 받음) 아무것도 하지 않는다', async () => {
      await expect(service().dispatch(null, 9)).resolves.toBe(true);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('가입 초대 알림톡 — 근무지 · 초대 코드(본문) · 초대 링크(직원 앱 origin + /invite#token=), 코드 · 링크는 이력에서 가린다', async () => {
      await expect(service().dispatch(pending(), 9)).resolves.toBe(true);
      expect(alimtalk.send).toHaveBeenCalledWith({
        templateCode: 'TALK_STAFF_INVITATION',
        to: PHONE,
        variables: {
          근무지: '모리커피 연남점',
          초대코드: 'K7Q2M9PX',
          링크: 'https://staff.whale.test/invite#token=tok-123',
        },
        maskedVariables: ['초대코드', '링크'],
        related: { type: 'contract', id: 7 },
        sentBy: 9,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('커밋 뒤 그사이 다른 요청(발송 대기 종료 · 재발송)이 초대를 무효로 했으면 보내지 않고, 나가지 않은 내 초대만 지운다', async () => {
      prisma.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
      tx.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
      await expect(service().dispatch(pending(), 9)).resolves.toBe(false);
      expect(prisma.invitation.findUnique).toHaveBeenCalledWith({
        where: { invitationId: 50 },
        select: { status: true },
      });
      expect(alimtalk.send).not.toHaveBeenCalled();
      // 남겨 두면 뒤이은 다른 요청의 되돌리기가 「앞 초대」로 되살린다 — 지우고, 계약 · 앞 초대는 그 요청에 맡긴다
      expect(tx.invitation.delete).toHaveBeenCalledWith({
        where: { invitationId: 50 },
      });
      expect(tx.invitationCodeAttempt.deleteMany).toHaveBeenCalled();
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.contract.update).not.toHaveBeenCalled();
    });

    const affiliationPending = () =>
      pending({
        ...input({ draftAction: 'AFFILIATION_CONFIRM' }),
        kind: 'AFFILIATION',
        code: null,
        token: null,
        unlockAttemptId: null,
        affiliation: {
          bpName: 'B',
          employmentType: '정직원',
          email: null,
          nameMismatch: false,
        },
      });

    it.each(['ACCEPTED', 'REJECTED'])(
      '커밋 직후 직원이 목록에서 이미 답했으면(%s) 처리된 것이라 보내지 않고 ANSWERED — 요청 · 계약을 건드리지 않는다(호출부가 지금 값을 다시 읽는다)',
      async (status) => {
        prisma.invitation.findUnique.mockResolvedValue({ status });
        await expect(service().dispatch(affiliationPending(), 9)).resolves.toBe(
          'ANSWERED',
        );
        expect(alimtalk.send).not.toHaveBeenCalled();
        expect(tx.invitation.delete).not.toHaveBeenCalled();
        expect(tx.contract.update).not.toHaveBeenCalled();
      },
    );

    it.each(['ACCEPTED', 'REJECTED'])(
      '알림톡이 거절된 뒤 되돌리다 직원이 이미 답한 것(%s)을 알면 지우지 · 되돌리지 않고 ANSWERED',
      async (status) => {
        alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
        tx.invitation.findUnique.mockResolvedValue({ status });
        await expect(service().dispatch(affiliationPending(), 9)).resolves.toBe(
          'ANSWERED',
        );
        expect(tx.invitation.delete).not.toHaveBeenCalled();
        expect(tx.contract.update).not.toHaveBeenCalled();
        expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
      },
    );

    const failWith = async (failure: unknown, p = pending()) => {
      alimtalk.send.mockRejectedValue(failure);
      const error = await service()
        .dispatch(p, 9)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadGatewayException);
      return (error as BadGatewayException).getResponse() as Record<
        string,
        unknown
      >;
    };

    it('되돌리기는 직원 행을 계약 행보다 먼저 잠근다 — 직원 행(가입 상태)을 되돌리므로', async () => {
      await failWith(new BizppurioError('거절', 4100, 400));
      // 직원 행(FOR NO KEY UPDATE) → 계약 행(FOR UPDATE) — 이어 쓰기 · 퇴직 확정 · 직원 앱 날인과 같은 순서(api #104)
      const sql = (tx.$executeRaw.mock.calls as unknown[][]).map((c) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join('?') : '',
      );
      const staff = sql.findIndex((s) =>
        /FROM staff_members .* FOR NO KEY UPDATE$/.test(s),
      );
      const contract = sql.findIndex((s) =>
        /FROM contracts .* FOR UPDATE$/.test(s),
      );
      expect(staff).toBeGreaterThanOrEqual(0);
      expect(staff).toBeLessThan(contract);
      expect((tx.$executeRaw.mock.calls as unknown[][])[staff][1]).toBe(3);
    });

    it('새 계약이 거절되면 임시저장으로 되돌린다 — 새 초대 삭제, 처음 이력은 임시저장으로, 직원은 초안 · 502 SEND_FAILED(계약 ID)', async () => {
      const body = await failWith(new BizppurioError('거절', 4100, 400));
      expect(body).toMatchObject({
        code: 'SEND_FAILED',
        retryable: true,
        contractId: 7,
        status: 'DRAFT',
      });
      expect(body.message).toContain('임시저장으로 두었습니다');
      expect(tx.invitation.delete).toHaveBeenCalledWith({
        where: { invitationId: 50 },
      });
      // 나가지 않은 발송이 푼 잠금도 되돌린다 — 같은 번호 키로 줄을 서서 해제 행과 그 뒤 시도까지(api #81 재리뷰)
      const phoneKey = invitationCodePhoneKeyOf(SECRET, PHONE);
      expect(tx.invitationCodeAttempt.deleteMany).toHaveBeenCalledWith({
        where: { phoneKey, invitationCodeAttemptId: { gte: 900 } },
      });
      const undoLock = (tx.$executeRaw.mock.calls as unknown[][]).findLastIndex(
        (c) => c.includes(phoneKey),
      );
      expect(tx.$executeRaw.mock.invocationCallOrder[undoLock]).toBeLessThan(
        tx.invitationCodeAttempt.deleteMany.mock.invocationCallOrder[0],
      );
      expect(tx.contract.update).toHaveBeenCalledWith({
        where: { contractId: 7 },
        data: {
          status: 'DRAFT',
          sentAt: null,
          signDeadlineAt: null,
          draftAction: null,
        },
      });
      expect(tx.contractStatusHistory.update).toHaveBeenCalledWith({
        where: { contractStatusHistoryId: 77 },
        data: { toStatus: 'DRAFT' },
      });
      expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        data: { joinStatus: 'DRAFT', candidateAccountId: null },
      });
    });

    it('되돌릴 때 그 뒤 해제 · 성공 행(isSucceeded)부터는 남긴다 — 다른 재발송으로 받은 코드가 막히지 않고, 끝난 초대가 맞아 옮겨 적은 (0, 없음) 행에서는 멈추지 않는다(api #81 3 · 4차 리뷰)', async () => {
      tx.invitationCodeAttempt.findFirst.mockResolvedValue({
        invitationCodeAttemptId: 950,
      });
      await failWith(new BizppurioError('거절', 4100, 400));
      const phoneKey = invitationCodePhoneKeyOf(SECRET, PHONE);
      expect(tx.invitationCodeAttempt.findFirst).toHaveBeenCalledWith({
        where: {
          phoneKey,
          invitationCodeAttemptId: { gt: 900 },
          isSucceeded: true,
        },
        orderBy: { invitationCodeAttemptId: 'asc' },
        select: { invitationCodeAttemptId: true },
      });
      expect(tx.invitationCodeAttempt.deleteMany).toHaveBeenCalledWith({
        where: { phoneKey, invitationCodeAttemptId: { gte: 900, lt: 950 } },
      });
    });

    it.each([
      ['요청 전 검사 오류(일반 Error)', new Error('휴대폰 번호가 아닙니다')],
      [
        '토큰 단계 네트워크 실패',
        new BizppurioError('/v1/token failed', undefined, undefined, {
          path: '/v1/token',
        }),
      ],
      [
        '토큰 단계 계정 오류(코드 있음)',
        new BizppurioError('/v1/token failed: http=401 code=3001', 3001, 401, {
          path: '/v1/token',
        }),
      ],
    ])('%s 는 나가지 않았다 — 되돌리고 502 SEND_FAILED', async (_, failure) => {
      const body = await failWith(failure);
      expect(body).toMatchObject({ code: 'SEND_FAILED', retryable: true });
      // 토큰 단계는 코드가 있어도 번호 탓이 아니다 — 발송 이력(sendFailureOf)과 같은 문구
      expect((body as { message: string }).message).not.toContain(
        '번호를 확인',
      );
      expect(tx.invitation.delete).toHaveBeenCalled();
    });

    it('메시지 요청 뒤 응답이 끊기면 되돌리지 않고 502 SEND_UNCONFIRMED(계약 ID)', async () => {
      const body = await failWith(
        new BizppurioError('socket hang up', undefined, undefined, {
          path: '/v3/message',
        }),
      );
      expect(body).toMatchObject({
        code: 'SEND_UNCONFIRMED',
        retryable: false,
        contractId: 7,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('되돌리기가 실패하면 502 SEND_UNCONFIRMED — DB 는 보낸 상태다', async () => {
      prisma.$transaction.mockRejectedValue(new Error('DB 끊김'));
      const body = await failWith(new BizppurioError('거절', 4100, 400));
      expect(body).toMatchObject({ code: 'SEND_UNCONFIRMED', contractId: 7 });
    });

    it('재발송(발송 대기)이 거절되면 앞 초대를 되살리고 앞 발송의 일시 · 기한으로 — 이력은 쓰지 않는다', async () => {
      const PREV_SENT = new Date('2026-10-10T01:00:00Z');
      const PREV_DEADLINE = new Date('2026-11-09T01:00:00Z');
      tx.invitation.count.mockResolvedValue(1);
      const body = await failWith(
        new BizppurioError('거절', 4100, 400),
        pending({
          statusChanged: false,
          historyId: null,
          expired: [40],
          before: {
            status: 'PENDING_SEND',
            sentAt: PREV_SENT,
            signDeadlineAt: PREV_DEADLINE,
            draftAction: 'SIGNUP_INVITE',
            staffMemberId: 3,
            staffMember: { joinStatus: 'INVITED', candidateAccountId: null },
          },
        }),
      );
      expect(body).toMatchObject({
        code: 'SEND_FAILED',
        status: 'PENDING_SEND',
      });
      expect(body.message).not.toContain('임시저장');
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: { in: [40] }, status: 'EXPIRED' },
        data: { status: 'SENT' },
      });
      expect(tx.contract.update).toHaveBeenCalledWith({
        where: { contractId: 7 },
        data: {
          status: 'PENDING_SEND',
          sentAt: PREV_SENT,
          signDeadlineAt: PREV_DEADLINE,
          draftAction: 'SIGNUP_INVITE',
          // 앞서 보낸 적이 있어 prepare 가 센 재발송을 뺀다(WHALEERP-328)
          resendCount: { decrement: 1 },
        },
      });
      expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.contractStatusHistory.delete).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('번호를 바꾼 저장이 거절되면 옛 번호의 초대는 되살리지 않고 임시저장으로 — 그 일을 시스템 이력으로 남긴다', async () => {
      const body = await failWith(
        new BizppurioError('거절', 4100, 400),
        pending({
          statusChanged: false,
          historyId: null,
          phoneChanged: true,
          expired: [40],
          before: {
            status: 'PENDING_SEND',
            sentAt: NOW,
            signDeadlineAt: DEADLINE,
            draftAction: 'SIGNUP_INVITE',
            staffMemberId: 3,
            staffMember: { joinStatus: 'INVITED', candidateAccountId: null },
          },
        }),
      );
      expect(body).toMatchObject({ code: 'SEND_FAILED', status: 'DRAFT' });
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      // 새 번호로 판별한 값(가입 초대 · 후보 없음)을 남긴다 — 옛 번호 값을 되살리지 않는다
      expect(tx.contract.update.mock.calls[0][0].data).toMatchObject({
        draftAction: 'SIGNUP_INVITE',
      });
      expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
        data: {
          contractId: 7,
          fromStatus: 'PENDING_SEND',
          toStatus: 'DRAFT',
          actor: 'SYSTEM',
        },
      });
      // 살아 있는 초대가 없어 직원도 초안으로
      expect(tx.staffMember.updateMany).toHaveBeenCalled();
    });

    it('수정 요청을 고친 저장이 거절되면 수정 요청으로 돌아가고 그 저장의 이력 줄을 지운다', async () => {
      const body = await failWith(
        new BizppurioError('거절', 4100, 400),
        pending({
          phoneChanged: true,
          before: {
            status: 'CORRECTION_REQUESTED',
            sentAt: NOW,
            signDeadlineAt: DEADLINE,
            draftAction: 'AFFILIATION_CONFIRM',
            staffMemberId: 3,
            staffMember: { joinStatus: 'DRAFT', candidateAccountId: 42 },
          },
        }),
      );
      expect(body).toMatchObject({ status: 'CORRECTION_REQUESTED' });
      expect(tx.contractStatusHistory.delete).toHaveBeenCalledWith({
        where: { contractStatusHistoryId: 77 },
      });
      expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        // 번호를 바꾼 저장이라 옛 번호의 후보 계정(42)은 되살리지 않는다
        data: { joinStatus: 'DRAFT', candidateAccountId: null },
      });
    });

    it('그사이 다른 요청이 다시 보냈으면(내 초대가 만료 · 발송 일시가 다름) 내 초대만 지우고 나머지는 둔다', async () => {
      tx.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        sentAt: new Date(NOW.getTime() + 1000),
      });
      const body = await failWith(new BizppurioError('거절', 4100, 400));
      expect(body).toMatchObject({
        code: 'SEND_FAILED',
        status: 'PENDING_SEND',
      });
      expect(tx.invitation.delete).toHaveBeenCalledWith({
        where: { invitationId: 50 },
      });
      expect(tx.contract.update).not.toHaveBeenCalled();
      expect(tx.contractStatusHistory.update).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('되돌리기가 되살리지 않는 것 (api #65 리뷰)', () => {
    it('번호를 계정 없는 번호로 바꾼 수정 요청이 거절되면 옛 번호의 초대 유형 · 후보 계정을 되살리지 않는다', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      await service()
        .dispatch(
          pending({
            phoneChanged: true,
            draftAction: 'SIGNUP_INVITE',
            before: {
              status: 'CORRECTION_REQUESTED',
              sentAt: NOW,
              signDeadlineAt: DEADLINE,
              draftAction: 'AFFILIATION_CONFIRM',
              staffMemberId: 3,
              staffMember: { joinStatus: 'DRAFT', candidateAccountId: 42 },
            },
          }),
          9,
        )
        .catch(() => undefined);
      expect(tx.contract.update.mock.calls[0][0].data).toMatchObject({
        status: 'CORRECTION_REQUESTED',
        draftAction: 'SIGNUP_INVITE',
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        data: { joinStatus: 'DRAFT', candidateAccountId: null },
      });
    });

    it('다른 계약을 대체한 저장이 거절되면 무효로 한 앞 초대(종료된 계약 때 나간 링크)를 되살리지 않는다', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      const body = await service()
        .dispatch(pending({ expired: [40], replacedContracts: true }), 9)
        .catch((e: unknown) => (e as BadGatewayException).getResponse());
      expect(body).toMatchObject({ code: 'SEND_FAILED', status: 'DRAFT' });
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('restoredStatusOf', () => {
    const p = (
      status:
        | 'PENDING_SEND'
        | 'PENDING_SIGNATURE'
        | 'DRAFT'
        | 'REJECTED'
        | 'EXPIRED'
        | null,
      over: {
        phoneChanged?: boolean;
        joined?: boolean;
        draftAction?: 'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM';
        /** 이번 저장이 판별한 값 — 없으면 앞 값과 같다 */
        decided?: 'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM';
      } = {},
    ) => ({
      before: {
        ...input().before,
        status,
        draftAction: over.draftAction ?? 'SIGNUP_INVITE',
      },
      draftAction: over.decided ?? over.draftAction ?? 'SIGNUP_INVITE',
      phoneChanged: over.phoneChanged ?? false,
      joined: over.joined ?? false,
    });

    it('거부 · 만료를 다시 보내다 실패하면 거부 · 만료로 돌아간다 — 임시저장이 되지 않는다(WHALEERP-153)', () => {
      expect(restoredStatusOf(p('REJECTED'), false)).toBe('REJECTED');
      expect(restoredStatusOf(p('EXPIRED'), false)).toBe('EXPIRED');
    });

    it('새 계약 · 임시저장에서 넘긴 것은 임시저장', () => {
      expect(restoredStatusOf(p(null), true)).toBe('DRAFT');
      expect(restoredStatusOf(p('DRAFT'), true)).toBe('DRAFT');
    });

    it('발송 대기는 살아 있는 초대가 있고 번호가 그대로일 때만 발송 대기', () => {
      expect(restoredStatusOf(p('PENDING_SEND'), true)).toBe('PENDING_SEND');
      expect(restoredStatusOf(p('PENDING_SEND'), false)).toBe('DRAFT');
      expect(
        restoredStatusOf(p('PENDING_SEND', { phoneChanged: true }), true),
      ).toBe('DRAFT');
    });

    it('앱으로 받던 서명 대기는 초대가 없어도 서명 대기(번호가 그대로면)', () => {
      expect(
        restoredStatusOf(
          p('PENDING_SIGNATURE', {
            draftAction: 'AFFILIATION_CONFIRM',
            joined: true,
          }),
          false,
        ),
      ).toBe('PENDING_SIGNATURE');
      expect(
        restoredStatusOf(
          p('PENDING_SIGNATURE', {
            draftAction: 'AFFILIATION_CONFIRM',
            joined: true,
            phoneChanged: true,
          }),
          false,
        ),
      ).toBe('DRAFT');
    });

    it('소속 추가 확인 요청(발송 대기)은 살아 있는 앞 요청이 있을 때만 발송 대기로 돌아간다', () => {
      const sent = p('PENDING_SEND', { draftAction: 'AFFILIATION_CONFIRM' });
      expect(restoredStatusOf(sent, true)).toBe('PENDING_SEND');
      expect(restoredStatusOf(sent, false)).toBe('DRAFT');
    });

    it('이 변경 전 요청 없이 서명 대기가 된 소속 확인 계약은 살아 있는 초대가 없어도 서명 대기로 돌아간다 — 발송 일시 · 기한을 지우지 않게(api #164 리뷰)', () => {
      expect(
        restoredStatusOf(
          p('PENDING_SIGNATURE', { draftAction: 'AFFILIATION_CONFIRM' }),
          false,
        ),
      ).toBe('PENDING_SIGNATURE');
    });

    it('번호가 같아도 다시 판별해 초대 유형이 바뀌었으면 앞 판별로 돌아가지 않는다 — 살아 있는 초대가 있어도 임시저장(api #164 리뷰)', () => {
      expect(
        restoredStatusOf(
          p('PENDING_SEND', { decided: 'AFFILIATION_CONFIRM' }),
          true,
        ),
      ).toBe('DRAFT');
    });
  });

  describe('다시 판별해 바뀐 저장의 되돌리기 (api #164 리뷰)', () => {
    it('가입 초대였던 번호에 계정이 생겨 소속 추가 확인 요청을 보내다 실패하면 — 앞 가입 초대를 되살리지 않고 새 판별(초대 유형)을 남긴다', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      tx.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        sentAt: NOW,
      });
      tx.invitation.count.mockResolvedValue(0);
      const before = {
        ...input().before,
        status: 'PENDING_SEND' as const,
        sentAt: new Date('2026-10-01T00:00:00Z'),
        signDeadlineAt: new Date('2026-10-31T00:00:00Z'),
        draftAction: 'SIGNUP_INVITE' as const,
        staffMember: { joinStatus: 'INVITED', candidateAccountId: null },
      };
      const error = await service()
        .dispatch(
          pending({
            ...input({ draftAction: 'AFFILIATION_CONFIRM', before }),
            kind: 'AFFILIATION',
            code: null,
            token: null,
            unlockAttemptId: null,
            affiliation: {
              bpName: 'B',
              employmentType: '정직원',
              email: null,
              nameMismatch: false,
            },
            expired: [40],
            historyId: null,
          }),
          9,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.contract.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DRAFT',
            draftAction: 'AFFILIATION_CONFIRM',
          }) as object,
        }),
      );
      // 소속 추가 확인 요청은 후보 계정을 건드리지 않는다 — 저장의 판별이 쓴 새 계정 그대로
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        data: { joinStatus: 'DRAFT' },
      });
    });

    it('소속 확인이던 번호의 계정이 탈퇴해 가입 초대를 보내다 실패하면 — 앞 요청 · 옛 후보 계정을 되살리지 않는다', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      tx.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        sentAt: NOW,
      });
      tx.invitation.count.mockResolvedValue(0);
      const before = {
        ...input().before,
        status: 'PENDING_SEND' as const,
        sentAt: new Date('2026-10-01T00:00:00Z'),
        signDeadlineAt: null,
        draftAction: 'AFFILIATION_CONFIRM' as const,
        staffMember: { joinStatus: 'INVITED', candidateAccountId: 42 },
      };
      await service()
        .dispatch(
          pending({ ...input({ before }), expired: [40], historyId: null }),
          9,
        )
        .catch(() => undefined);
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.contract.update.mock.calls[0][0].data).toMatchObject({
        status: 'DRAFT',
        draftAction: 'SIGNUP_INVITE',
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        data: { joinStatus: 'DRAFT', candidateAccountId: null },
      });
    });

    it('옛 소속 확인 서명 대기 계약을 재발송하다 실패하면 서명 대기 · 앞 발송 일시 · 기한으로 돌아간다', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      tx.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        sentAt: NOW,
      });
      tx.invitation.count.mockResolvedValue(0);
      const sentAt = new Date('2026-10-01T00:00:00Z');
      const signDeadlineAt = new Date('2026-10-31T00:00:00Z');
      const before = {
        ...input().before,
        status: 'PENDING_SIGNATURE' as const,
        sentAt,
        signDeadlineAt,
        draftAction: 'AFFILIATION_CONFIRM' as const,
        staffMember: { joinStatus: 'DRAFT', candidateAccountId: 42 },
      };
      const body = (
        (await service()
          .dispatch(
            pending({
              ...input({ draftAction: 'AFFILIATION_CONFIRM', before }),
              kind: 'AFFILIATION',
              code: null,
              token: null,
              unlockAttemptId: null,
              affiliation: {
                bpName: 'B',
                employmentType: '정직원',
                email: null,
                nameMismatch: false,
              },
              expired: [],
            }),
            9,
          )
          .catch((e: unknown) => e)) as BadGatewayException
      ).getResponse();
      expect(body).toMatchObject({
        code: 'SEND_FAILED',
        status: 'PENDING_SIGNATURE',
      });
      expect(tx.contract.update.mock.calls[0][0].data).toMatchObject({
        status: 'PENDING_SIGNATURE',
        sentAt,
        signDeadlineAt,
        draftAction: 'AFFILIATION_CONFIRM',
      });
    });
  });
});
