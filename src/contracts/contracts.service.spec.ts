import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractsService } from './contracts.service';

// 보내기(ContractDeliveryService)는 따로 시험한다 — 여기서는 무엇을 넘기는지만 본다. 기본은 앱으로 받음(보낼 것 없음)
const delivery = {
  prepare: jest.fn<
    Promise<unknown>,
    [unknown, Record<string, unknown>, Date]
  >(),
  dispatch: jest.fn<Promise<void>, [unknown, number]>(),
};
beforeEach(() => {
  delivery.prepare.mockReset().mockResolvedValue(null);
  delivery.dispatch.mockReset().mockResolvedValue(undefined);
});

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
  let scope: { getManageableStores: jest.Mock };

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
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [
          { storeId: 11, storeTypeCode: 'FRANCHISE' },
          { storeId: 12, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
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
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: delivery },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('한 페이지와 전체 건수를 { items, total } 로 준다', async () => {
    const result = await service.list(9, { page: 1, pageSize: 20 });

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
    await service.list(9, { page: 3, pageSize: 20 });

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
    await service.list(9, {
      page: 1,
      pageSize: 20,
      status: ['SIGNED', 'REJECTED'],
      staffMemberName: '도윤',
    });

    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({
      storeId: { in: [11, 12] },
      status: { in: ['SIGNED', 'REJECTED'] },
      staffMember: { name: { contains: '도윤', mode: 'insensitive' } },
    });
  });

  // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름으로 점포를 먼저 찾고 그 id 로 거른다.
  it('점포 이름으로 거를 때는 업무 범위 안에서 그 이름의 점포 id 로 거른다', async () => {
    prisma.store.findMany
      .mockResolvedValueOnce([{ storeId: 11 }])
      .mockResolvedValueOnce([{ storeId: 11, name: '모리커피 서초점' }]);

    await service.list(9, { page: 1, pageSize: 20, storeName: '서초' });

    expect(prisma.store.findMany.mock.calls[0][0]).toEqual({
      where: {
        storeId: { in: [11, 12] },
        name: { contains: '서초', mode: 'insensitive' },
      },
      select: { storeId: true },
    });
    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({ storeId: { in: [11] } });
  });

  it('점포 이름에 맞는 점포가 없으면 계약을 읽지 않고 빈 목록이다', async () => {
    prisma.store.findMany.mockResolvedValueOnce([]);

    const result = await service.list(9, {
      page: 1,
      pageSize: 20,
      storeName: '없는점포',
    });

    expect(result).toEqual({ items: [], total: 0 });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  it('본사 역할에게 직영이 아닌 점포의 계약은 본사 제공 동의한 직원 것만 읽는다 — 직원 목록이 내보내는 계약과 같게', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'BM',
      stores: [
        { storeId: 11, storeTypeCode: 'DIRECT' },
        { storeId: 12, storeTypeCode: 'FRANCHISE' },
      ],
    });

    await service.list(9, { page: 1, pageSize: 20 });

    expect(scope.getManageableStores).toHaveBeenCalledWith(9);
    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({
      OR: [
        { storeId: { in: [11] } },
        {
          storeId: { in: [12] },
          staffMember: { account: { is: { isHqSharingConsented: true } } },
        },
      ],
    });
  });

  it('동의 조건과 직원 이름 조건은 함께 걸린다 — 이름으로 동의 안 한 직원 계약이 새지 않게', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'BA',
      stores: [{ storeId: 12, storeTypeCode: 'FRANCHISE' }],
    });

    await service.list(9, { page: 1, pageSize: 20, staffMemberName: '도윤' });

    const [{ where }] = prisma.contract.findMany.mock.calls[0];
    expect(where).toEqual({
      OR: [
        { storeId: { in: [] } },
        {
          storeId: { in: [12] },
          staffMember: { account: { is: { isHqSharingConsented: true } } },
        },
      ],
      staffMember: { name: { contains: '도윤', mode: 'insensitive' } },
    });
  });

  it('관리하는 점포가 없으면 계약을 읽지 않고 빈 목록이다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'PM',
      stores: [],
    });
    await expect(service.list(9, { page: 1, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  it('사용 중인 관리자 계정이 아니면 403', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await expect(
      service.list(9, { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('점포 이름은 이 페이지에 나온 점포만 한 번에 읽는다', async () => {
    prisma.contract.findMany.mockResolvedValueOnce([
      row,
      { ...row, contractId: 8 },
    ]);

    await service.list(9, { page: 1, pageSize: 20 });

    expect(prisma.store.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [11] } },
      select: { storeId: true, name: true },
    });
  });

  it('마지막 페이지를 넘기면 빈 items 와 total 을 준다', async () => {
    prisma.contract.findMany.mockResolvedValueOnce([]);

    const result = await service.list(9, { page: 99, pageSize: 20 });

    expect(result).toEqual({ items: [], total: 41 });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
