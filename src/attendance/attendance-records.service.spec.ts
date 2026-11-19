import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceRecordsService } from './attendance-records.service';

// 일별 · 기간 · 열린 출근이 모두 거치는 점포 범위(scopeOf)만 본다 — 공개 메서드는 출퇴근 계산까지 엮여 있어,
// 점포 유형(storeTypes)이 어느 점포를 남기는지는 범위 계산 하나로 확인한다.
describe('AttendanceRecordsService — 점포 범위(storeTypes, 본사 점포)', () => {
  let service: AttendanceRecordsService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: { store: { findMany: jest.Mock } };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT', isHq: false },
          { storeId: 2, storeTypeCode: 'FRANCHISE', isHq: false },
          { storeId: 3, storeTypeCode: 'DIRECT', isHq: true },
        ],
      }),
    };
    prisma = {
      store: {
        findMany: jest.fn(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(
              where.storeId.in.map((storeId) => ({
                storeId,
                name: `점포${storeId}`,
              })),
            ),
        ),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        AttendanceRecordsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(AttendanceRecordsService);
  });

  /** private scopeOf 를 부른다 — 위 주석의 이유로 범위 계산만 떼어 본다. */
  const storeIdsOf = async (storeTypes?: string[]) => {
    const result = await (
      service as unknown as {
        scopeOf: (
          id: number,
          q: { storeTypes?: string[] },
        ) => Promise<{ storeIds: number[] }>;
      }
    ).scopeOf(9, storeTypes ? { storeTypes } : {});
    return result.storeIds;
  };

  it('HQ 는 본사 점포만 — 폐점을 빼고 묻는다', async () => {
    await expect(storeIdsOf(['HQ'])).resolves.toEqual([3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [3] }, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true, name: true, isHq: true },
    });
  });

  it('DIRECT 는 본사가 아닌 직영만', async () => {
    await expect(storeIdsOf(['DIRECT'])).resolves.toEqual([1]);
  });

  it('유형이 없으면 본사 포함 전부 — 폐점 조건 없이 묻는다', async () => {
    await expect(storeIdsOf()).resolves.toEqual([1, 2, 3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [1, 2, 3] } },
      select: { storeId: true, name: true, isHq: true },
    });
  });
});
