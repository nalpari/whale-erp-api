import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ContractExpiryService } from './contract-expiry.service';

describe('ContractExpiryService', () => {
  let service: ContractExpiryService;
  let tx: {
    contract: { updateManyAndReturn: jest.Mock };
    contractStatusHistory: { createMany: jest.Mock };
  };
  const now = new Date('2026-10-06T15:00:00Z');

  beforeEach(async () => {
    tx = {
      contract: {
        updateManyAndReturn: jest
          .fn()
          .mockResolvedValue([{ contractId: 1 }, { contractId: 2 }]),
      },
      contractStatusHistory: { createMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContractExpiryService],
    }).compile();
    service = module.get(ContractExpiryService);
  });

  const run = () =>
    service.expireOverdue(tx as unknown as Prisma.TransactionClient, now);

  it('서명 기한이 지난 서명 대기 계약만 만료로 바꾼다', async () => {
    await run();

    expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith({
      where: { status: 'PENDING_SIGNATURE', signDeadlineAt: { lte: now } },
      data: { status: 'EXPIRED' },
      select: { contractId: true },
    });
  });

  it('바뀐 계약마다 시스템 처리로 상태 이력을 남긴다', async () => {
    await run();

    expect(tx.contractStatusHistory.createMany).toHaveBeenCalledWith({
      data: [1, 2].map((contractId) => ({
        contractId,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'EXPIRED',
        actor: 'SYSTEM',
      })),
    });
  });

  it('처리 건수를 돌려준다', async () => {
    await expect(run()).resolves.toBe(2);
  });

  it('기준 시각을 넘기지 않으면 현재 시각을 쓴다', async () => {
    jest.useFakeTimers({ now });
    try {
      await service.expireOverdue(tx as unknown as Prisma.TransactionClient);
    } finally {
      jest.useRealTimers();
    }

    expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING_SIGNATURE', signDeadlineAt: { lte: now } },
      }),
    );
  });

  it('대상이 없으면 이력을 쓰지 않고 0을 돌려준다', async () => {
    tx.contract.updateManyAndReturn.mockResolvedValue([]);

    await expect(run()).resolves.toBe(0);
    expect(tx.contractStatusHistory.createMany).not.toHaveBeenCalled();
  });

  // contracts 마이그레이션이 들어가면 실제 DB 로 검증한다. mock 은 where 의 모양만 본다.
  it.todo('두 번째 실행은 0을 돌려주고 이력을 더 쓰지 않는다');
  it.todo('서명 트랜잭션과 겹쳐도 체결 완료된 계약은 만료되지 않는다');
});
