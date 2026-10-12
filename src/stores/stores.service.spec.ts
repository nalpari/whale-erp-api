import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
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

  beforeEach(async () => {
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
      providers: [StoresService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(StoresService);
  });

  it('지우지 않았고 폐점이 아닌 점포를 이름순(+ id)으로 준다', async () => {
    await expect(service.list({ page: 2, pageSize: 50 })).resolves.toEqual({
      items: [{ storeId: 11, name: '모리커피 서초점' }],
      total: 1,
    });

    const [args] = prisma.store.findMany.mock.calls[0];
    const where = { isDeleted: false, storeStatusCode: { not: 'CLOSED' } };
    expect(args).toEqual({
      where,
      select: { storeId: true, name: true },
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
      skip: 50,
      take: 50,
    });
    expect(prisma.store.count.mock.calls[0][0]).toEqual({ where });
  });
});
