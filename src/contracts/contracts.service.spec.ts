import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContractsService } from './contracts.service';

describe('ContractsService', () => {
  let service: ContractsService;
  // 인자 타입을 적어 두어야 mock.calls 가 any 가 아니다.
  let prisma: {
    $transaction: jest.Mock;
    contract: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.ContractFindManyArgs]>;
      count: jest.Mock<Promise<number>, [Prisma.ContractCountArgs]>;
    };
    store: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StoreFindManyArgs]>;
    };
  };

  const row = {
    contractId: 7,
    staffMemberId: 3,
    storeId: 11,
    employmentType: 'PART_TIME',
    contractMethod: 'ELECTRONIC',
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: null,
    wageAmount: 11200,
    status: 'PENDING_SIGNATURE',
    draftAction: 'SIGNUP_INVITE',
    sentAt: new Date('2026-09-01T02:00:00Z'),
    signDeadlineAt: new Date('2026-10-01T02:00:00Z'),
    staffMember: { name: '권도윤' },
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
      contract: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.ContractFindManyArgs]>()
          .mockResolvedValue([row]),
        count: jest
          .fn<Promise<number>, [Prisma.ContractCountArgs]>()
          .mockResolvedValue(41),
      },
      store: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.StoreFindManyArgs]>()
          .mockResolvedValue([{ storeId: 11, name: '모리커피 서초점' }]),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('한 페이지와 전체 건수를 { items, total } 로 준다', async () => {
    const result = await service.list({ page: 1, pageSize: 20 });

    expect(result.total).toBe(41);
    expect(result.items).toEqual([
      {
        contractId: 7,
        staffMemberId: 3,
        staffMemberName: '권도윤',
        storeId: 11,
        storeName: '모리커피 서초점',
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: '2026-09-01',
        endDate: null,
        wageAmount: 11200,
        status: 'PENDING_SIGNATURE',
        draftAction: 'SIGNUP_INVITE',
        sentAt: '2026-09-01T02:00:00.000Z',
        signDeadlineAt: '2026-10-01T02:00:00.000Z',
      },
    ]);
  });

  it('목록과 건수는 같은 where 로, 최신 등록순 + contractId 로 정렬해 자른다', async () => {
    await service.list({ page: 3, pageSize: 20 });

    const [findArgs] = prisma.contract.findMany.mock.calls[0];
    const [countArgs] = prisma.contract.count.mock.calls[0];
    expect(findArgs.where).toEqual(countArgs.where);
    expect(findArgs.orderBy).toEqual([
      { createdAt: 'desc' },
      { contractId: 'desc' },
    ]);
    expect(findArgs.skip).toBe(40);
    expect(findArgs.take).toBe(20);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('상태 · 직원 이름으로 거른다', async () => {
    await service.list({
      page: 1,
      pageSize: 20,
      status: ['SIGNED', 'REJECTED'],
      staffMemberName: '도윤',
    });

    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({
      status: { in: ['SIGNED', 'REJECTED'] },
      staffMember: { name: { contains: '도윤', mode: 'insensitive' } },
    });
  });

  // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름으로 점포를 먼저 찾고 그 id 로 거른다.
  it('점포 이름으로 거를 때는 그 이름의 점포 id 로 거른다', async () => {
    prisma.store.findMany
      .mockResolvedValueOnce([{ storeId: 11 }, { storeId: 12 }])
      .mockResolvedValueOnce([{ storeId: 11, name: '모리커피 서초점' }]);

    await service.list({ page: 1, pageSize: 20, storeName: '서초' });

    expect(prisma.store.findMany.mock.calls[0][0]).toEqual({
      where: { name: { contains: '서초', mode: 'insensitive' } },
      select: { storeId: true },
    });
    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({ storeId: { in: [11, 12] } });
  });

  it('점포 이름에 맞는 점포가 없으면 빈 목록이다', async () => {
    prisma.store.findMany.mockResolvedValueOnce([]);
    prisma.contract.findMany.mockResolvedValueOnce([]);
    prisma.contract.count.mockResolvedValueOnce(0);

    const result = await service.list({
      page: 1,
      pageSize: 20,
      storeName: '없는점포',
    });

    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({ storeId: { in: [] } });
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('점포 이름은 이 페이지에 나온 점포만 한 번에 읽는다', async () => {
    prisma.contract.findMany.mockResolvedValueOnce([
      row,
      { ...row, contractId: 8 },
    ]);

    await service.list({ page: 1, pageSize: 20 });

    expect(prisma.store.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [11] } },
      select: { storeId: true, name: true },
    });
  });

  it('마지막 페이지를 넘기면 빈 items 와 total 을 준다', async () => {
    prisma.contract.findMany.mockResolvedValueOnce([]);

    const result = await service.list({ page: 99, pageSize: 20 });

    expect(result).toEqual({ items: [], total: 41 });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
