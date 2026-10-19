import { BadGatewayException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContractDeliveryService,
  SEND_VALID_MS,
} from './contract-delivery.service';
import { ContractSendService } from './contract-send.service';
import { ContractsService } from './contracts.service';

// 근로계약 재발송(WHALEERP-136). 보내기 자체(초대 · 알림톡 · 되돌리기)는 contract-delivery.service.spec 에서 본다
describe('ContractSendService (재발송)', () => {
  const NOW = new Date('2026-10-19T01:00:00Z');
  const PHONE = '01090145563';
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING_SEND',
    storeId: 11,
    sentAt: new Date('2026-10-10T01:00:00Z'),
    signDeadlineAt: new Date('2026-11-09T01:00:00Z'),
    draftAction: 'SIGNUP_INVITE',
    staffMemberId: 3,
    staffMember: {
      phone: PHONE,
      joinStatus: 'INVITED',
      candidateAccountId: null,
    },
    ...over,
  });

  let tx: {
    $executeRaw: jest.Mock;
    contract: { findUnique: jest.Mock };
    account: { findMany: jest.Mock };
    staffMember: { findMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let contracts: { scopedContractOf: jest.Mock };
  let delivery: { prepare: jest.Mock; dispatch: jest.Mock };
  const PENDING = { invitationId: 50 };

  const service = () =>
    new ContractSendService(
      prisma as unknown as PrismaService,
      contracts as unknown as ContractsService,
      delivery as unknown as ContractDeliveryService,
    );

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: { findUnique: jest.fn().mockResolvedValue(row()) },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    contracts = {
      scopedContractOf: jest
        .fn()
        .mockResolvedValue({ storeId: 11, phone: PHONE }),
    };
    delivery = {
      prepare: jest.fn().mockResolvedValue(PENDING),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
  });

  it.each(['PENDING_SEND', 'PENDING_SIGNATURE'])(
    '%s 면 상태는 그대로 가입 초대를 새로 보낸다 — 보내기 직전 값을 넘기고 커밋 뒤 보낸다',
    async (status) => {
      tx.contract.findUnique.mockResolvedValue(row({ status }));
      const result = await service().send(9, 7, NOW);
      expect(result).toEqual({
        contractId: 7,
        status,
        sentAt: NOW.toISOString(),
        signDeadlineAt: new Date(NOW.getTime() + SEND_VALID_MS).toISOString(),
      });
      expect(delivery.prepare).toHaveBeenCalledWith(
        tx,
        {
          contractId: 7,
          storeId: 11,
          phone: PHONE,
          joined: false,
          draftAction: 'SIGNUP_INVITE',
          before: {
            status,
            sentAt: row().sentAt,
            signDeadlineAt: row().signDeadlineAt,
            draftAction: 'SIGNUP_INVITE',
            staffMemberId: 3,
            staffMember: row().staffMember,
          },
          statusChanged: false,
          phoneChanged: false,
          replacedContracts: false,
        },
        NOW,
      );
      expect(delivery.dispatch).toHaveBeenCalledWith(PENDING, 9);
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        delivery.dispatch.mock.invocationCallOrder[0],
      );
    },
  );

  it('가입한 직원이면 409 SEND_CHANNEL_NOT_READY — 판별 · 쓰기 없이(앱 알림 준비 전)', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({
        status: 'PENDING_SIGNATURE',
        staffMember: {
          phone: PHONE,
          joinStatus: 'JOINED',
          candidateAccountId: null,
        },
      }),
    );
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_CHANNEL_NOT_READY',
    });
    expect(tx.account.findMany).not.toHaveBeenCalled();
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

  it('그 번호로 계정이 생겼으면 409 SEND_CHANNEL_NOT_READY', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_CHANNEL_NOT_READY',
      draftAction: 'AFFILIATION_CONFIRM',
    });
    expect(delivery.prepare).not.toHaveBeenCalled();
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
      expect(delivery.prepare).not.toHaveBeenCalled();
    },
  );

  it('범위를 본 뒤 다른 요청이 번호를 고쳤으면 409', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({
        staffMember: {
          phone: '01011112222',
          joinStatus: 'INVITED',
          candidateAccountId: null,
        },
      }),
    );
    await expect(service().send(9, 7, NOW)).rejects.toThrow(
      '다른 요청이 먼저 근로계약을 고쳤습니다',
    );
  });

  it('보내기가 실패하면 그 오류를 그대로 낸다', async () => {
    delivery.dispatch.mockRejectedValue(new BadGatewayException('x'));
    await expect(service().send(9, 7, NOW)).rejects.toThrow(
      BadGatewayException,
    );
  });
});
