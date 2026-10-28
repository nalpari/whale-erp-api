import { BadGatewayException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContractDeliveryService,
  SEND_VALID_MS,
} from './contract-delivery.service';
import { ContractSendService } from './contract-send.service';
import { SIGNED_ONCE } from './signed-contract';
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
    $queryRaw: jest.Mock;
    contract: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    store: { findFirst: jest.Mock };
    contractStatusHistory: { create: jest.Mock };
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
      // 폐점 · 삭제가 아닌 점포(FOR SHARE 로 잠가 읽음)
      $queryRaw: jest.fn().mockResolvedValue([{ store_id: 11 }]),
      contract: {
        findUnique: jest.fn().mockResolvedValue(row()),
        // 다른 진행 중 계약 · 다른 재계약 — 없다
        findFirst: jest.fn().mockResolvedValue(null),
        // 되살릴 계약의 근무 요일 · 기간(겹침 검사) — 근무 요일이 없어 겹침을 보지 않는다
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          storeId: 11,
          startDate: null,
          endDate: null,
          contractWorkDays: [],
        }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // 폐점 · 삭제가 아닌 점포
      store: { findFirst: jest.fn().mockResolvedValue({ storeId: 11 }) },
      contractStatusHistory: { create: jest.fn().mockResolvedValue({}) },
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

  it('그 번호로 계정이 생겼으면(소속 추가 확인) 409 SEND_CHANNEL_NOT_READY — 앱에 소속 확인이 없어 받을 길이 없다', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_CHANNEL_NOT_READY',
      draftAction: 'AFFILIATION_CONFIRM',
      message:
        '계정이 있는 번호는 직원 앱에서 소속을 확인한 뒤 근로계약서를 받습니다. 소속 확인이 아직 직원 앱에 없어 다시 보낼 수 없습니다',
    });
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

  it('이 점포의 퇴직 레코드가 그 번호의 계정이면(복귀 확인) 409 SEND_CHANNEL_NOT_READY', async () => {
    tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    tx.staffMember.findMany.mockResolvedValue([
      { employmentStatus: 'RETIRED' },
    ]);
    const error = await service()
      .send(9, 7, NOW)
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SEND_CHANNEL_NOT_READY',
      draftAction: 'RETURN_CONFIRM',
    });
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

  describe('거부 · 만료 재발송 (WHALEERP-153)', () => {
    const reopened = (status: string, over: Record<string, unknown> = {}) =>
      row({
        status,
        previousContractId: null,
        startDate: new Date('2026-11-01T00:00:00Z'),
        endDate: null,
        staffMember: {
          phone: PHONE,
          joinStatus: 'JOINED',
          candidateAccountId: null,
          employmentStatus: 'EMPLOYED',
          retiredDate: null,
        },
        ...over,
      });

    it.each(['REJECTED', 'EXPIRED'])(
      '가입한 직원의 %s 계약은 서명 대기로 되살려 새 기한으로 앱에 다시 보낸다',
      async (status) => {
        tx.contract.findUnique.mockResolvedValue(reopened(status));
        delivery.prepare.mockResolvedValue(null);

        const result = await service().send(9, 7, NOW);

        expect(result.status).toBe('PENDING_SIGNATURE');
        expect(tx.contract.updateMany).toHaveBeenCalledWith({
          where: { contractId: 7, status },
          data: { status: 'PENDING_SIGNATURE' },
        });
        const [, input] = delivery.prepare.mock.calls[0] as [
          unknown,
          {
            joined: boolean;
            statusChanged: boolean;
            before: { status: string };
          },
        ];
        expect(input).toMatchObject({
          joined: true,
          statusChanged: true,
          before: { status },
        });
      },
    );

    it('퇴직한 직원 · 퇴직일을 정한 직원(지났든 아니든)에게는 다시 보내지 않는다(api #158 리뷰)', async () => {
      for (const staff of [
        { employmentStatus: 'RETIRED', retiredDate: new Date('2026-10-01') },
        { employmentStatus: 'EMPLOYED', retiredDate: new Date('2026-10-18') },
        { employmentStatus: 'EMPLOYED', retiredDate: new Date('2026-12-31') },
      ]) {
        tx.contract.findUnique.mockResolvedValue(
          reopened('REJECTED', {
            staffMember: {
              phone: PHONE,
              joinStatus: 'JOINED',
              candidateAccountId: null,
              ...staff,
            },
          }),
        );
        await expect(service().send(9, 7, NOW)).rejects.toThrow(
          '퇴직했거나 퇴직일을 정한 직원에게는 근로계약서를 다시 보낼 수 없습니다',
        );
      }
      expect(delivery.prepare).not.toHaveBeenCalled();
    });

    it('계약 기간이 끝난 계약은 되살리지 않는다(api #158 code-review)', async () => {
      tx.contract.findUnique.mockResolvedValue(
        reopened('EXPIRED', {
          startDate: new Date('2026-01-01T00:00:00Z'),
          endDate: new Date('2026-10-18T00:00:00Z'),
        }),
      );

      await expect(service().send(9, 7, NOW)).rejects.toThrow(
        '계약 기간이 끝난 근로계약서는 다시 보낼 수 없습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('폐점했거나 지운 점포의 계약은 되살리지 않는다(api #158 리뷰)', async () => {
      tx.contract.findUnique.mockResolvedValue(reopened('EXPIRED'));
      tx.$queryRaw.mockResolvedValueOnce([]);

      await expect(service().send(9, 7, NOW)).rejects.toThrow(
        '폐점했거나 지운 점포의 근로계약서는 다시 보낼 수 없습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('다른 점포 계약과 근무 시간이 겹치면 409 WORK_TIME_OVERLAP — 계약에 남은 근무 요일로 본다(api #158 리뷰)', async () => {
      tx.contract.findUnique.mockResolvedValue(reopened('REJECTED'));
      tx.contract.findUniqueOrThrow.mockResolvedValueOnce({
        storeId: 11,
        startDate: new Date('2026-11-01T00:00:00Z'),
        endDate: null,
        contractWorkDays: [
          {
            weekday: 'MON',
            startTime: new Date('1970-01-01T10:00:00Z'),
            endTime: new Date('1970-01-01T16:00:00Z'),
          },
        ],
      });
      tx.contract.findMany.mockResolvedValueOnce([
        {
          startDate: new Date('2026-10-01T00:00:00Z'),
          endDate: null,
          staffMember: { retiredDate: null },
          contractWorkDays: [
            {
              weekday: 'MON',
              startTime: new Date('1970-01-01T12:00:00Z'),
              endTime: new Date('1970-01-01T18:00:00Z'),
            },
          ],
          store: { name: '모리커피 성수점' },
        },
      ]);

      const error = await service()
        .send(9, 7, NOW)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'WORK_TIME_OVERLAP',
      });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('같은 점포 · 번호에 다른 진행 중 계약이 있으면 409 — 둘이 함께 살아나지 않게', async () => {
      tx.contract.findUnique.mockResolvedValue(reopened('EXPIRED'));
      tx.contract.findFirst.mockResolvedValueOnce({ contractId: 8 });

      await expect(service().send(9, 7, NOW)).rejects.toThrow(
        '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('재계약이면 같은 직전 계약에 이어지는 다른 재계약이 살아 있을 때 409(WHALEERP-156)', async () => {
      tx.contract.findUnique.mockResolvedValue(
        reopened('REJECTED', { previousContractId: 5 }),
      );
      tx.contract.findFirst
        .mockResolvedValueOnce(null) // 진행 중
        .mockResolvedValueOnce(null) // 체결 완료
        .mockResolvedValueOnce({ contractId: 9 }); // 다른 재계약

      await expect(service().send(9, 7, NOW)).rejects.toThrow(
        '직전 계약에 이어지는 다른 재계약이 있습니다',
      );
    });

    it('같은 점포 · 번호에 체결 완료인 다른 계약이 있으면 409 — 직전 계약은 빼고 본다(api #158 code-review)', async () => {
      tx.contract.findUnique.mockResolvedValue(
        reopened('REJECTED', { previousContractId: 5 }),
      );
      tx.contract.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ contractId: 6 });

      const error = await service()
        .send(9, 7, NOW)
        .catch((e: unknown) => e);
      // 화면이 까닭을 보이게 code 를 싣는다(api #158 리뷰)
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'REOPEN_BLOCKED',
        message: expect.stringContaining(
          '체결 완료된 근로계약이 있습니다',
        ) as unknown,
      });
      const [, signedQuery] = tx.contract.findFirst.mock.calls as [
        unknown,
        [{ where: unknown }],
      ];
      // 이 계약 기간과 겹치는 것만 · 이 계약과 직전 계약(줄의 앞 계약)은 빼고(api #158 리뷰), 기간이 끝나 배치가 닫은 계약도
      // 본다(SIGNED_ONCE, api #158 재리뷰 참고 1)
      expect(signedQuery[0].where).toMatchObject({
        ...SIGNED_ONCE,
        contractId: { notIn: [7, 5] },
      });
    });
  });

  it.each(['DRAFT', 'CORRECTION_REQUESTED', 'SIGNED', 'ENDED'])(
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

  it('화면이 본 상태(expectedStatus)와 지금 상태가 다르면 409 CONTRACT_STATUS_CONFLICT — 그사이 거부된 계약을 되살리지 않는다(front #136 재리뷰)', async () => {
    tx.contract.findUnique.mockResolvedValue(row({ status: 'REJECTED' }));
    const error = await service()
      .send(9, 7, NOW, { status: 'PENDING_SIGNATURE' })
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'REJECTED',
    });
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

  it('화면이 본 상태와 같으면 그대로 보낸다', async () => {
    tx.contract.findUnique.mockResolvedValue(row());
    await expect(
      service().send(9, 7, NOW, {
        status: 'PENDING_SEND',
        sentAt: '2026-10-10T01:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'PENDING_SEND' });
  });

  it('상태가 같아도 화면이 본 발송 시각과 다르면 409 — 다른 탭에서 먼저 다시 보냈다(front #136 셀프 code-review)', async () => {
    tx.contract.findUnique.mockResolvedValue(row());
    const error = await service()
      .send(9, 7, NOW, {
        status: 'PENDING_SEND',
        sentAt: '2026-10-09T01:00:00.000Z',
      })
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
    });
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

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
