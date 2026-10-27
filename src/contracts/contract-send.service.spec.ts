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
    contract: { findUnique: jest.Mock; updateMany: jest.Mock };
    contractStatusHistory: { create: jest.Mock };
    account: { findMany: jest.Mock };
    staffMember: { findMany: jest.Mock; update: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    contract: { findUnique: jest.Mock };
  };
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
      contract: {
        findUnique: jest.fn().mockResolvedValue(row()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contractStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
      contract: { findUnique: jest.fn() },
    };
    contracts = {
      scopedContractOf: jest
        .fn()
        .mockResolvedValue({ storeId: 11, phone: PHONE }),
    };
    delivery = {
      prepare: jest.fn().mockResolvedValue(PENDING),
      dispatch: jest.fn().mockResolvedValue(true),
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

  it('번호 잠금 다음 직원 행을 계약 행보다 먼저 잠근다 — 보내기가 직원 행(가입 상태)을 쓰므로', async () => {
    await service().send(9, 7, NOW);
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

  const joinedRow = (status: string) =>
    row({
      status,
      draftAction: 'AFFILIATION_CONFIRM',
      staffMember: {
        phone: PHONE,
        joinStatus: 'JOINED',
        candidateAccountId: null,
      },
    });

  it('가입한 직원의 서명 대기 계약은 앱 알림으로 다시 보낸다 — 판별 없이 첫 발송과 같은 길(prepare, joined), 알림톡은 없다(WHALEERP-611)', async () => {
    tx.contract.findUnique.mockResolvedValue(joinedRow('PENDING_SIGNATURE'));
    delivery.prepare.mockResolvedValue(null);
    const result = await service().send(9, 7, NOW);
    expect(result).toEqual({
      contractId: 7,
      status: 'PENDING_SIGNATURE',
      sentAt: NOW.toISOString(),
      signDeadlineAt: new Date(NOW.getTime() + SEND_VALID_MS).toISOString(),
    });
    // 가입한 직원은 자기 레코드가 재직이라 판별하면 「이미 재직 중」이 된다 — 계정을 찾지 않는다
    expect(tx.account.findMany).not.toHaveBeenCalled();
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(delivery.prepare).toHaveBeenCalledWith(
      tx,
      {
        contractId: 7,
        storeId: 11,
        phone: PHONE,
        joined: true,
        draftAction: 'AFFILIATION_CONFIRM',
        before: {
          status: 'PENDING_SIGNATURE',
          sentAt: row().sentAt,
          signDeadlineAt: row().signDeadlineAt,
          draftAction: 'AFFILIATION_CONFIRM',
          staffMemberId: 3,
          staffMember: joinedRow('PENDING_SIGNATURE').staffMember,
        },
        statusChanged: false,
        phoneChanged: false,
        replacedContracts: false,
      },
      NOW,
    );
    expect(delivery.dispatch).toHaveBeenCalledWith(null, 9);
  });

  it('가입한 직원의 발송 대기 계약은 서명 대기로 넘겨 보낸다 — 앱은 발송 대기 계약을 보이지 않는다', async () => {
    // 잠글 직원 · 읽기 · 전환 전 상태 모두 같은 행
    tx.contract.findUnique.mockResolvedValue(joinedRow('PENDING_SEND'));
    delivery.prepare.mockResolvedValue(null);
    const result = await service().send(9, 7, NOW);
    expect(result.status).toBe('PENDING_SIGNATURE');
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SEND' },
      data: { status: 'PENDING_SIGNATURE' },
    });
    expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SEND',
        toStatus: 'PENDING_SIGNATURE',
        actor: 'ADMIN',
      },
    });
    const [, input] = delivery.prepare.mock.calls[0] as [
      unknown,
      { joined: boolean; statusChanged: boolean; before: { status: string } },
    ];
    expect(input).toMatchObject({
      joined: true,
      statusChanged: true,
      before: { status: 'PENDING_SEND' },
    });
  });

  it.each([
    ['소속 추가 확인', [], 'AFFILIATION_CONFIRM'],
    [
      '복귀 확인 — 이 점포의 퇴직 레코드가 그 계정',
      [{ employmentStatus: 'RETIRED' }],
      'RETURN_CONFIRM',
    ],
  ])(
    '그 번호로 계정이 생겼으면(%s) 소속 추가 확인 요청을 새로 보낸다 — 후보 계정을 잇고 발송 대기, 날인 기한은 수락 뒤라 null(WHALEERP-130)',
    async (_, records, draftAction) => {
      tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      tx.staffMember.findMany.mockResolvedValue(records);
      const result = await service().send(9, 7, NOW);
      expect(result).toEqual({
        contractId: 7,
        status: 'PENDING_SEND',
        sentAt: NOW.toISOString(),
        signDeadlineAt: null,
      });
      expect(tx.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 3 },
        data: { candidateAccountId: 42 },
      });
      expect((delivery.prepare.mock.calls as unknown[][])[0][1]).toMatchObject({
        joined: false,
        draftAction,
        statusChanged: false,
      });
    },
  );

  it('보내기 전에 직원이 소속 추가 확인 요청을 수락했으면(ANSWERED) 계산한 발송 대기 · null 기한이 아니라 지금 상태 · 기한을 싣는다(api #164 리뷰)', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    delivery.dispatch.mockResolvedValue('ANSWERED');
    const deadline = new Date(NOW.getTime() + SEND_VALID_MS);
    prisma.contract.findUnique.mockResolvedValue({
      status: 'PENDING_SIGNATURE',
      sentAt: NOW,
      signDeadlineAt: deadline,
    });
    await expect(service().send(9, 7, NOW)).resolves.toEqual({
      contractId: 7,
      status: 'PENDING_SIGNATURE',
      sentAt: NOW.toISOString(),
      signDeadlineAt: deadline.toISOString(),
    });
  });

  it('계정이 있는 번호의 옛 서명 대기는 발송 대기로 되돌려 소속 추가 확인 요청을 보낸다 — 수락 전이다', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    tx.contract.findUnique.mockResolvedValue(
      row({ status: 'PENDING_SIGNATURE', draftAction: 'AFFILIATION_CONFIRM' }),
    );
    const result = await service().send(9, 7, NOW);
    expect(result.status).toBe('PENDING_SEND');
    expect(tx.contract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING_SEND' } }),
    );
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

  it.each(['SIGNED', 'CORRECTION_REQUESTED'])(
    '가입한 직원이어도 %s 이면 409 CONTRACT_STATUS_CONFLICT — 전환 · 보내기 없이',
    async (status) => {
      tx.contract.findUnique.mockResolvedValue(joinedRow(status));
      const error = await service()
        .send(9, 7, NOW)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
      });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
      expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
      expect(delivery.prepare).not.toHaveBeenCalled();
      expect(delivery.dispatch).not.toHaveBeenCalled();
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

  it('커밋 뒤 다른 요청(발송 대기 종료 · 재발송)이 초대를 무효로 해 보내지 않았으면 409 — 화면이 다시 읽는다', async () => {
    delivery.dispatch.mockResolvedValue(false);
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
