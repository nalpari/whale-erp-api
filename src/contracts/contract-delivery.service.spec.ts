import {
  BadGatewayException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AlimtalkService } from '../alimtalk/alimtalk.service';
import { BizppurioError } from '../alimtalk/bizppurio.client';
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
    staffMember: { update: jest.Mock; updateMany: jest.Mock };
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
    invitationCodeAttempt: { create: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
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
      staffMember: { update: jest.fn(), updateMany: jest.fn() },
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
      invitationCodeAttempt: { create: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((work: (x: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
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
    it('가입 전이고 계정이 없으면 가입 초대(발송 대기), 가입했거나 계정이 있으면 앱(서명 대기)', () => {
      expect(channelOf(false, 'SIGNUP_INVITE')).toBe('INVITE');
      expect(deliveredStatusOf(false, 'SIGNUP_INVITE')).toBe('PENDING_SEND');
      for (const action of ['AFFILIATION_CONFIRM', 'RETURN_CONFIRM'] as const)
        expect(deliveredStatusOf(false, action)).toBe('PENDING_SIGNATURE');
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
        hashInvitationCode(pending!.code, SECRET),
      );
      expect(created.data.invitationToken).toBe(hashToken(pending!.token));
      expect(created.data.invitationToken).not.toContain(pending!.token);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('가입 초대를 보내면 그 번호의 초대 코드 입력 잠금을 푼다 — 실패 0 행(JOIN-7)', async () => {
      await service().prepare(t(), input(), NOW);
      expect(tx.invitationCodeAttempt.create).toHaveBeenCalledWith({
        data: {
          phoneKey: invitationCodePhoneKeyOf(SECRET, PHONE),
          failedCount: 0,
          lockExpiresAt: null,
          attemptedAt: NOW,
        },
      });
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

    it.each([
      ['가입한 직원', { joined: true }],
      ['계정이 있는 번호', { draftAction: 'AFFILIATION_CONFIRM' as const }],
    ])(
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
    code: 'K7Q2M9PX',
    token: 'tok-123',
    invitationId: 50,
    historyId: 77,
    expired: [],
    storeName: '모리커피 연남점',
    now: NOW,
    ...over,
  });

  describe('dispatch', () => {
    it('보낼 것이 없으면(앱으로 받음) 아무것도 하지 않는다', async () => {
      await service().dispatch(null, 9);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('가입 초대 알림톡 — 근무지 · 초대 코드(본문) · 초대 링크(직원 앱 origin + /invite#token=), 코드 · 링크는 이력에서 가린다', async () => {
      await service().dispatch(pending(), 9);
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

    it.each([
      ['요청 전 검사 오류(일반 Error)', new Error('휴대폰 번호가 아닙니다')],
      [
        '토큰 단계 네트워크 실패',
        new BizppurioError('/v1/token failed', undefined, undefined, {
          path: '/v1/token',
        }),
      ],
    ])('%s 는 나가지 않았다 — 되돌리고 502 SEND_FAILED', async (_, failure) => {
      const body = await failWith(failure);
      expect(body).toMatchObject({ code: 'SEND_FAILED', retryable: true });
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
      status: 'PENDING_SEND' | 'PENDING_SIGNATURE' | 'DRAFT' | null,
      over: {
        phoneChanged?: boolean;
        joined?: boolean;
        draftAction?: 'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM';
      } = {},
    ) => ({
      before: {
        ...input().before,
        status,
        draftAction: over.draftAction ?? 'SIGNUP_INVITE',
      },
      phoneChanged: over.phoneChanged ?? false,
      joined: over.joined ?? false,
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
          p('PENDING_SIGNATURE', { draftAction: 'AFFILIATION_CONFIRM' }),
          false,
        ),
      ).toBe('PENDING_SIGNATURE');
      expect(
        restoredStatusOf(
          p('PENDING_SIGNATURE', {
            draftAction: 'AFFILIATION_CONFIRM',
            phoneChanged: true,
          }),
          false,
        ),
      ).toBe('DRAFT');
    });
  });
});
