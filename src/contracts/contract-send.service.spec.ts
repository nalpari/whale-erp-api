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
import {
  ContractSendService,
  hashInvitationToken,
  SEND_VALID_MS,
} from './contract-send.service';
import { ContractsService } from './contracts.service';

// 근로계약 발송 · 재발송(WHALEERP-136, 2026-10-16) — 가입 초대만, 알림톡은 커밋 뒤에
describe('ContractSendService', () => {
  const NOW = new Date('2026-10-16T01:00:00Z');
  const PHONE = '01090145563';
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING_SEND',
    storeId: 11,
    sentAt: null,
    signDeadlineAt: null,
    draftAction: 'SIGNUP_INVITE',
    staffMemberId: 3,
    staffMember: {
      phone: PHONE,
      joinStatus: 'DRAFT',
      candidateAccountId: null,
    },
    ...over,
  });

  let tx: {
    $executeRaw: jest.Mock;
    contract: {
      findUnique: jest.Mock;
      updateMany: jest.Mock<
        Promise<{ count: number }>,
        [Prisma.ContractUpdateManyArgs]
      >;
    };
    contractStatusHistory: {
      create: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
    account: { findMany: jest.Mock };
    staffMember: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    store: { findUnique: jest.Mock };
    invitation: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock<Promise<unknown>, [Prisma.InvitationCreateArgs]>;
      delete: jest.Mock;
    };
  };
  let prisma: {
    $transaction: jest.Mock;
    notificationTemplate: { findUnique: jest.Mock };
  };
  let alimtalk: { send: jest.Mock; hasSmsFallback: jest.Mock };
  let contracts: { scopedContractOf: jest.Mock };
  let appUrl: string | undefined;

  const service = () =>
    new ContractSendService(
      prisma as unknown as PrismaService,
      contracts as unknown as ContractsService,
      alimtalk as unknown as AlimtalkService,
      { get: () => appUrl } as unknown as ConfigService,
    );

  beforeEach(() => {
    appUrl = 'https://staff.whale.test/some/path';
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        findUnique: jest.fn().mockResolvedValue(row()),
        updateMany: jest
          .fn<Promise<{ count: number }>, [Prisma.ContractUpdateManyArgs]>()
          .mockResolvedValue({ count: 1 }),
      },
      contractStatusHistory: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ contractStatusHistoryId: 77 }),
        deleteMany: jest.fn(),
      },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      store: {
        findUnique: jest.fn().mockResolvedValue({ name: '모리커피 연남점' }),
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
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
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
    };
    alimtalk = {
      send: jest.fn().mockResolvedValue({ referenceKey: 'r' }),
      hasSmsFallback: jest.fn().mockReturnValue(true),
    };
    contracts = {
      scopedContractOf: jest
        .fn()
        .mockResolvedValue({ storeId: 11, phone: PHONE }),
    };
  });

  it('발송 대기 → 서명 대기. 가입 초대(토큰은 해시로만 저장) · 30일 기한 · 직원 초대 발송, 커밋 뒤 알림톡', async () => {
    const result = await service().send(9, 7, NOW);
    const deadline = new Date(NOW.getTime() + SEND_VALID_MS);
    expect(result).toEqual({
      contractId: 7,
      status: 'PENDING_SIGNATURE',
      sentAt: NOW.toISOString(),
      signDeadlineAt: deadline.toISOString(),
    });
    const [created] = tx.invitation.create.mock.calls[0];
    expect(created.data).toMatchObject({
      staffMemberId: 3,
      invitationType: 'SIGNUP',
      channel: 'ALIMTALK',
      sentAt: NOW,
      expiresAt: deadline,
      status: 'SENT',
    });
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SEND' },
      data: {
        sentAt: NOW,
        signDeadlineAt: deadline,
        draftAction: 'SIGNUP_INVITE',
        status: 'PENDING_SIGNATURE',
      },
    });
    expect(tx.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: { joinStatus: 'INVITED', candidateAccountId: null },
    });
    // 알림톡 — 근무지 · 링크(직원 앱 origin + /invite/토큰), 링크는 이력에서 가린다
    const [sent] = alimtalk.send.mock.calls[0] as [
      { variables: Record<string, string> },
    ];
    expect(alimtalk.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'TALK_STAFF_INVITATION',
        to: PHONE,
        maskedVariables: ['링크'],
        related: { type: 'contract', id: 7 },
        sentBy: 9,
      }),
    );
    expect(sent.variables.근무지).toBe('모리커피 연남점');
    const link = sent.variables.링크;
    expect(link.startsWith('https://staff.whale.test/invite/')).toBe(true);
    const token = link.slice('https://staff.whale.test/invite/'.length);
    expect(created.data.invitationToken).toBe(hashInvitationToken(token));
    expect(created.data.invitationToken).not.toBe(token);
    // 쓰기가 끝난 뒤(트랜잭션 밖)에 보낸다
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      alimtalk.send.mock.invocationCallOrder[0],
    );
  });

  it('서명 대기면 재발송 — 상태는 그대로, 앞 초대는 만료로 바꾸고 재초대 · 새 기한', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ status: 'PENDING_SIGNATURE' }),
    );
    tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
    tx.invitation.count.mockResolvedValue(1);
    await service().send(9, 7, NOW);
    expect(tx.invitation.updateMany).toHaveBeenCalledWith({
      where: { invitationId: { in: [40] } },
      data: { status: 'EXPIRED' },
    });
    expect(tx.invitation.create.mock.calls[0][0].data).toMatchObject({
      invitationType: 'REINVITE',
    });
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: expect.objectContaining({
        signDeadlineAt: new Date(NOW.getTime() + SEND_VALID_MS),
      }) as object,
    });
    expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
  });

  it('그 번호로 계정이 있으면(소속 추가 · 복귀) 409 SEND_CHANNEL_NOT_READY — 쓰지도 보내지도 않는다', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_CHANNEL_NOT_READY',
      draftAction: 'AFFILIATION_CONFIRM',
    });
    expect(tx.invitation.create).not.toHaveBeenCalled();
    expect(alimtalk.send).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'CORRECTION_REQUESTED', 'SIGNED', 'EXPIRED'])(
    '%s 이면 409 CONTRACT_STATUS_CONFLICT',
    async (status) => {
      tx.contract.findUnique.mockResolvedValue(row({ status }));
      const error = await service()
        .send(9, 7, NOW)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
      });
      expect(alimtalk.send).not.toHaveBeenCalled();
    },
  );

  it('직원 앱 주소가 없으면 503 — 트랜잭션 전에', async () => {
    appUrl = undefined;
    await expect(service().send(9, 7, NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('가입 초대 템플릿이 꺼져 있으면 503 — 쓰기 전에', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      isActive: false,
      channel: 'ALIMTALK',
    });
    await expect(service().send(9, 7, NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('비즈뿌리오가 거절하면(코드 있음) 되돌리고 502 SEND_FAILED(다시 보낼 수 있음)', async () => {
    alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
    // 보낼 때 두 번(읽기 · 전환) 발송 대기, 되돌릴 때는 커밋된 서명 대기를 읽는다
    tx.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row())
      .mockResolvedValue(row({ status: 'PENDING_SIGNATURE', sentAt: NOW }));
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      code: 'SEND_FAILED',
      retryable: true,
    });
    // 되돌리기 — 새 초대 삭제, 계약은 발송 대기로(발송 이력은 지운다), 직원은 초안으로
    expect(tx.invitation.delete).toHaveBeenCalledWith({
      where: { invitationId: 50 },
    });
    expect(tx.contract.updateMany).toHaveBeenLastCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: {
        sentAt: null,
        signDeadlineAt: null,
        draftAction: 'SIGNUP_INVITE',
        status: 'PENDING_SEND',
      },
    });
    expect(tx.contractStatusHistory.deleteMany).toHaveBeenCalledWith({
      where: { contractStatusHistoryId: 77 },
    });
    // 되돌리기는 상태 이력을 새로 쓰지 않는다 — 발송 한 줄만 썼다가 지웠다
    expect(tx.contractStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
      where: { staffMemberId: 3, joinStatus: 'INVITED' },
      data: { joinStatus: 'DRAFT', candidateAccountId: null },
    });
  });

  it('번호가 휴대폰이 아니면(유선) 409 SEND_PHONE_NOT_MOBILE — 쓰지도 보내지도 않는다', async () => {
    contracts.scopedContractOf.mockResolvedValue({
      storeId: 11,
      phone: '0212345678',
    });
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_PHONE_NOT_MOBILE',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(alimtalk.send).not.toHaveBeenCalled();
  });

  it('대체 문자 발신번호가 없으면 503 — 링크가 닿을 길이 없어 쓰기 전에 막는다', async () => {
    alimtalk.hasSmsFallback.mockReturnValue(false);
    await expect(service().send(9, 7, NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    alimtalk.send.mockRejectedValue(failure);
    tx.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row())
      .mockResolvedValue(row({ status: 'PENDING_SIGNATURE', sentAt: NOW }));
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      code: 'SEND_FAILED',
      retryable: true,
    });
    expect(tx.invitation.delete).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('되돌리기가 실패하면 502 SEND_UNCONFIRMED — DB 는 보낸 상태다', async () => {
    alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
    prisma.$transaction
      .mockImplementationOnce((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      )
      .mockRejectedValueOnce(new Error('DB 끊김'));
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      code: 'SEND_UNCONFIRMED',
      retryable: false,
    });
  });

  it('그사이 다른 요청이 다시 보냈으면(내 초대가 만료 · 발송 일시가 다름) 내 초대만 지우고 계약 · 직원 · 앞 초대는 둔다', async () => {
    alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
    tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
    tx.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row())
      .mockResolvedValue(
        row({
          status: 'PENDING_SIGNATURE',
          sentAt: new Date(NOW.getTime() + 1000),
        }),
      );
    tx.invitation.findUnique.mockResolvedValue({ status: 'EXPIRED' });
    await service()
      .send(9, 7, NOW)
      .catch(() => undefined);
    expect(tx.invitation.delete).toHaveBeenCalledWith({
      where: { invitationId: 50 },
    });
    // 보낼 때 앞 초대를 만료로 바꾼 한 번뿐 — 되살리지 않는다
    expect(tx.invitation.updateMany).toHaveBeenCalledTimes(1);
    // 보낼 때(전환) 한 번뿐 — 되돌리지 않는다
    expect(tx.contract.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contractStatusHistory.deleteMany).not.toHaveBeenCalled();
    expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
  });

  describe('재발송이 거절되면', () => {
    const PREV_SENT = new Date('2026-10-10T01:00:00Z');
    const PREV_DEADLINE = new Date('2026-11-09T01:00:00Z');
    beforeEach(() => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      tx.invitation.findMany.mockResolvedValue([{ invitationId: 40 }]);
      const before = row({
        status: 'PENDING_SIGNATURE',
        sentAt: PREV_SENT,
        signDeadlineAt: PREV_DEADLINE,
        staffMember: {
          phone: PHONE,
          joinStatus: 'INVITED',
          candidateAccountId: null,
        },
      });
      tx.contract.findUnique
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(
          row({ status: 'PENDING_SIGNATURE', sentAt: NOW }),
        )
        .mockResolvedValue(row({ status: 'PENDING_SIGNATURE', sentAt: NOW }));
    });

    it('앞 초대가 살아 있으면 앞 발송의 일시 · 기한으로 돌린다', async () => {
      tx.invitation.count.mockResolvedValue(1);
      await service()
        .send(9, 7, NOW)
        .catch(() => undefined);
      expect(tx.invitation.updateMany).toHaveBeenLastCalledWith({
        where: { invitationId: { in: [40] }, status: 'EXPIRED' },
        data: { status: 'SENT' },
      });
      expect(tx.contract.updateMany).toHaveBeenLastCalledWith({
        where: { contractId: 7, status: 'PENDING_SIGNATURE' },
        data: {
          sentAt: PREV_SENT,
          signDeadlineAt: PREV_DEADLINE,
          draftAction: 'SIGNUP_INVITE',
        },
      });
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('앞 초대가 없으면(동시 발송이 모두 거절돼 앞 요청이 지움) 서명 대기로 두지 않고 발송 대기 · 직원은 초안으로', async () => {
      // 보낼 때 센 이전 초대는 있었지만(재초대), 되돌릴 때는 살아 있는 초대가 없다
      tx.invitation.count.mockResolvedValueOnce(1).mockResolvedValue(0);
      await service()
        .send(9, 7, NOW)
        .catch(() => undefined);
      expect(tx.contract.updateMany).toHaveBeenLastCalledWith({
        where: { contractId: 7, status: 'PENDING_SIGNATURE' },
        data: { sentAt: null, signDeadlineAt: null, status: 'PENDING_SEND' },
      });
      expect(tx.contractStatusHistory.create).toHaveBeenLastCalledWith({
        data: {
          contractId: 7,
          fromStatus: 'PENDING_SIGNATURE',
          toStatus: 'PENDING_SEND',
          actor: 'SYSTEM',
        },
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, joinStatus: 'INVITED' },
        data: { joinStatus: 'DRAFT', candidateAccountId: null },
      });
    });
  });

  it('응답을 기다리는 사이 근로자 정보 수정이 발송 대기로 돌렸으면 발송 일시 · 직원 초대 발송도 되돌린다', async () => {
    alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
    tx.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row())
      .mockResolvedValue(row({ status: 'PENDING_SEND', sentAt: NOW }));
    await service()
      .send(9, 7, NOW)
      .catch(() => undefined);
    expect(tx.invitation.delete).toHaveBeenCalledWith({
      where: { invitationId: 50 },
    });
    expect(tx.contract.updateMany).toHaveBeenLastCalledWith({
      where: { contractId: 7, status: 'PENDING_SEND', sentAt: NOW },
      data: { sentAt: null },
    });
    expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
      where: { staffMemberId: 3, joinStatus: 'INVITED' },
      data: { joinStatus: 'DRAFT', candidateAccountId: null },
    });
    // 이력은 두 요청이 실제로 바꾼 것이라 지우지 않는다
    expect(tx.contractStatusHistory.deleteMany).not.toHaveBeenCalled();
  });

  it('응답이 끊겨 접수 여부를 모르면 되돌리지 않고 502 SEND_UNCONFIRMED(다시 보내면 두 번 갈 수 있음)', async () => {
    alimtalk.send.mockRejectedValue(
      new BizppurioError('socket hang up', undefined, undefined, {
        path: '/v3/message',
      }),
    );
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      code: 'SEND_UNCONFIRMED',
      retryable: false,
    });
    expect(tx.invitation.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
