import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractFilesService } from './contract-files.service';
import { ContractsService } from './contracts.service';

// 작성 · 이어 쓰기의 근무지 선택지(GET /contracts/store-options, WHALEERP-638 — 옛 GET /stores/options). 대상 BP 는
// contracts.target-bp.spec 이 본다.
describe('근로계약 근무지 선택지', () => {
  let service: ContractsService;
  let prisma: {
    $transaction: jest.Mock;
    store: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StoreFindManyArgs]>;
      count: jest.Mock<Promise<number>, [Prisma.StoreCountArgs]>;
    };
  };
  let scope: { getManageableStores: jest.Mock };
  const bp = { bpCodeId: 3, isPlatformCaller: false };

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
    const module = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: {} },
        { provide: ContractFilesService, useValue: {} },
        { provide: PERSONAL_DATA_KEY, useValue: null },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('업무 범위 안에서 지우지 않았고 폐점이 아닌 점포를 이름순(+ id)으로 준다', async () => {
    await expect(
      service.storeOptions(9, { page: 2, pageSize: 50 }, bp),
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
    expect(scope.getManageableStores).toHaveBeenCalledWith(9, bp);
  });

  it('본사 역할에게 직영이 아닌 점포는 빠진다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'BM',
      stores: [
        { storeId: 11, storeTypeCode: 'DIRECT' },
        { storeId: 12, storeTypeCode: 'FRANCHISE' },
      ],
    });
    await service.storeOptions(9, { page: 1, pageSize: 50 }, bp);
    expect(prisma.store.findMany.mock.calls[0][0].where?.storeId).toEqual({
      in: [11],
    });
  });

  it('사용 중인 관리자 계정이 아니면 403', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await expect(
      service.storeOptions(9, { page: 1, pageSize: 50 }, bp),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
