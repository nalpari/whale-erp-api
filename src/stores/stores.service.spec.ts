import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from './stores.service';

describe('StoresService', () => {
  let service: StoresService;
  let prisma: {
    $transaction: jest.Mock;
    store: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StoreFindManyArgs]>;
      count: jest.Mock<Promise<number>, [Prisma.StoreCountArgs]>;
    };
  };
  let scope: { getManageableStores: jest.Mock };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 11, storeTypeCode: 'FRANCHISE' }],
      }),
    };
    prisma = {
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
      store: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.StoreFindManyArgs]>()
          .mockResolvedValue([{ storeId: 11, name: '모리커피 서초점' }]),
        count: jest
          .fn<Promise<number>, [Prisma.StoreCountArgs]>()
          .mockResolvedValue(1),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoresService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(StoresService);
  });

  it('업무 범위 안에서 지우지 않았고 폐점이 아닌 점포를 이름순(+ id)으로 준다', async () => {
    await expect(
      service.options(9, { page: 2, pageSize: 50 }),
    ).resolves.toEqual({
      items: [{ storeId: 11, name: '모리커피 서초점' }],
      total: 1,
    });

    const [args] = prisma.store.findMany.mock.calls[0];
    const where = {
      storeId: { in: [11] },
      isDeleted: false,
      storeStatusCode: { not: 'CLOSED' },
    };
    expect(args).toEqual({
      where,
      select: { storeId: true, name: true },
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
      skip: 50,
      take: 50,
    });
    expect(prisma.store.count.mock.calls[0][0]).toEqual({ where });
    expect(scope.getManageableStores).toHaveBeenCalledWith(9);
  });

  it('본사 역할에게 직영이 아닌 점포는 빠진다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'BM',
      stores: [
        { storeId: 11, storeTypeCode: 'DIRECT' },
        { storeId: 12, storeTypeCode: 'FRANCHISE' },
      ],
    });
    await service.options(9, { page: 1, pageSize: 50 });
    expect(prisma.store.findMany.mock.calls[0][0].where?.storeId).toEqual({
      in: [11],
    });
  });

  it('사용 중인 관리자 계정이 아니면 403', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await expect(
      service.options(9, { page: 1, pageSize: 50 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
