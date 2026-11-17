import { pickedStores } from './payslip-shared';

describe('pickedStores — 상단 점포 범위 유형(storeTypes)', () => {
  const manageable = [
    { storeId: 1, storeTypeCode: 'DIRECT', isHq: false },
    { storeId: 2, storeTypeCode: 'FRANCHISE', isHq: false },
    { storeId: 3, storeTypeCode: 'DIRECT', isHq: true },
  ];
  let prisma: { store: { findMany: jest.Mock } };

  beforeEach(() => {
    // 폐점 점포는 없다 — 넘긴 점포를 모두 운영 중으로 돌려준다
    prisma = {
      store: {
        findMany: jest.fn(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(where.storeId.in.map((storeId) => ({ storeId }))),
        ),
      },
    };
  });
  const pick = (storeTypes?: string[]) =>
    pickedStores(prisma as never, manageable, undefined, storeTypes);
  const ids = (rows: { storeId: number }[]) => rows.map((s) => s.storeId);

  it('HQ 는 본사 점포만', async () => {
    expect(ids(await pick(['HQ']))).toEqual([3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [3] }, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true },
    });
  });

  it('DIRECT 는 본사가 아닌 직영만 — 본사는 store_type_code 가 DIRECT 여도 빠진다', async () => {
    expect(ids(await pick(['DIRECT']))).toEqual([1]);
  });

  it('유형을 주지 않으면 전부(본사 포함), 폐점을 묻지 않는다', async () => {
    expect(ids(await pick())).toEqual([1, 2, 3]);
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
