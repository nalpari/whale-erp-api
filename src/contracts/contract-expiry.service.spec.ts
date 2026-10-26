import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ContractExpiryService } from './contract-expiry.service';

describe('ContractExpiryService (근로계약 하루 배치)', () => {
  let service: ContractExpiryService;
  let tx: {
    contract: { updateManyAndReturn: jest.Mock };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
    invitation: { updateMany: jest.Mock };
  };
  // 한국 시간 2026-10-07 00:00 — 배치가 도는 자정
  const now = new Date('2026-10-06T15:00:00Z');
  const TODAY = new Date('2026-10-07T00:00:00Z');

  /** updateManyAndReturn 은 서명 대기 만료 → 발송 대기 만료 → 종료 → 갱신 예정 차례로 불린다 */
  const changed = (...lists: number[][]) => {
    for (const ids of lists)
      tx.contract.updateManyAndReturn.mockResolvedValueOnce(
        ids.map((contractId) => ({ contractId })),
      );
  };

  beforeEach(async () => {
    tx = {
      contract: { updateManyAndReturn: jest.fn().mockResolvedValue([]) },
      contractStatusHistory: {
        // 바뀐 계약마다 이력 하나 — 이력 ID 는 계약 ID + 100
        createManyAndReturn: jest.fn(
          (args: { data: { contractId: number }[] }) =>
            Promise.resolve(
              args.data.map(({ contractId }) => ({
                contractId,
                contractStatusHistoryId: contractId + 100,
              })),
            ),
        ),
      },
      invitation: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContractExpiryService],
    }).compile();
    service = module.get(ContractExpiryService);
  });

  const run = () =>
    service.runDaily(tx as unknown as Prisma.TransactionClient, now);
  const argsOf = (i: number) =>
    (tx.contract.updateManyAndReturn.mock.calls[i] as [{ where: unknown }])[0];

  it('날인 기한이 지난 서명 대기 · 발송 대기 계약을 만료로 바꾸고, 이력 ID 를 함께 돌려준다(만료 알림의 사건 키)', async () => {
    changed([1, 2], [3]);

    const result = await run();

    expect(argsOf(0).where).toEqual({
      signDeadlineAt: { lte: now },
      status: 'PENDING_SIGNATURE',
    });
    // 가입 초대에 30일 안에 가입하지 않은 발송 대기도 만료한다(2026-10-26 김민식)
    expect(argsOf(1).where).toEqual({
      signDeadlineAt: { lte: now },
      status: 'PENDING_SEND',
    });
    expect(result.expired).toEqual([
      { contractId: 1, historyId: 101 },
      { contractId: 2, historyId: 102 },
      { contractId: 3, historyId: 103 },
    ]);
    expect(tx.contractStatusHistory.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          contractId: 3,
          fromStatus: 'PENDING_SEND',
          toStatus: 'EXPIRED',
          actor: 'SYSTEM',
        },
      ],
      select: { contractId: true, contractStatusHistoryId: true },
    });
  });

  it('기한이 지난 「보냄」 초대를 만료로 바꾼다', async () => {
    const result = await run();

    expect(tx.invitation.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENT', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    expect(result.invitationsExpired).toBe(3);
  });

  it('계약 종료일이 한국 날짜로 오늘보다 앞인 체결 완료 계약을 종료로 바꾼다', async () => {
    changed([], [], [7]);

    const result = await run();

    expect(argsOf(2).where).toEqual({
      endDate: { lt: TODAY },
      status: 'SIGNED',
    });
    expect(result.ended).toEqual([7]);
  });

  it('종료일이 오늘부터 30일 안인 체결 완료 계약 가운데 아직 알리지 않은 것에 보낸 때를 남기고 돌려준다 — 계약마다 한 번', async () => {
    changed([], [], [], [9]);

    const result = await run();

    expect(argsOf(3)).toEqual({
      where: {
        status: 'SIGNED',
        renewalNotifiedAt: null,
        endDate: { gte: TODAY, lte: new Date('2026-11-06T00:00:00Z') },
      },
      data: { renewalNotifiedAt: now },
      select: { contractId: true },
    });
    expect(result.renewalDue).toEqual([9]);
  });

  it('대상이 없으면 이력을 쓰지 않고 빈 결과다', async () => {
    tx.invitation.updateMany.mockResolvedValue({ count: 0 });

    await expect(run()).resolves.toEqual({
      expired: [],
      invitationsExpired: 0,
      ended: [],
      renewalDue: [],
    });
    expect(tx.contractStatusHistory.createManyAndReturn).not.toHaveBeenCalled();
  });
});
