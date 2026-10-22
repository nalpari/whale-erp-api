import type { UseStatus } from '@prisma/client';
import { copyProvidedItems, providedOriginals } from './provided-code-copy';

describe('플랫폼제공 상세 코드 복사', () => {
  let tx: {
    codeGroup: { findMany: jest.Mock };
    codeItem: { findMany: jest.Mock; createMany: jest.Mock };
  };
  const original = (
    groupCode: string,
    itemCode: string,
    status: UseStatus = 'ACTIVE',
  ) => ({
    groupCode,
    itemCode,
    label: `코드 ${itemCode}`,
    status,
    sortOrder: 1,
  });

  beforeEach(() => {
    tx = {
      codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      codeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  });

  describe('providedOriginals', () => {
    const itemWhere = (groupCodes: string[]) => ({
      groupCode: { in: groupCodes },
      bpCode: 'BP000000',
      isDeleted: false,
      manageOwnerCode: { not: 'BP_ONLY' },
    });

    it('고른 그룹의 플랫폼 원본을 읽는다 — 지운 것 · BP전용은 빼고 사용중지는 넣는다', async () => {
      tx.codeItem.findMany.mockResolvedValue([original('EMP_TYPE', 'FULL')]);

      const rows = await providedOriginals(tx as never, ['EMP_TYPE']);

      expect(tx.codeGroup.findMany).not.toHaveBeenCalled();
      expect(tx.codeItem.findMany).toHaveBeenCalledWith({
        where: itemWhere(['EMP_TYPE']),
        select: {
          groupCode: true,
          itemCode: true,
          label: true,
          status: true,
          sortOrder: true,
        },
        orderBy: [
          { groupCode: 'asc' },
          { sortOrder: 'asc' },
          { itemCode: 'asc' },
        ],
      });
      expect(rows).toEqual([original('EMP_TYPE', 'FULL')]);
    });

    it('그룹을 고르지 않으면 지우지 않은 플랫폼제공 그룹 전부 — 적용 여부 · 사용 상태는 보지 않는다', async () => {
      tx.codeGroup.findMany.mockResolvedValue([
        { groupCode: 'EMP_TYPE' },
        { groupCode: 'LEAVE_TYPE' },
      ]);

      await providedOriginals(tx as never);

      expect(tx.codeGroup.findMany).toHaveBeenCalledWith({
        where: { manageOwnerCode: 'PLATFORM_PROVIDED', isDeleted: false },
        select: { groupCode: true },
      });
      expect(tx.codeItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: itemWhere(['EMP_TYPE', 'LEAVE_TYPE']),
        }),
      );
    });

    it('플랫폼제공 그룹이 없으면 상세 코드를 묻지 않고 빈 목록', async () => {
      await expect(providedOriginals(tx as never)).resolves.toEqual([]);
      expect(tx.codeItem.findMany).not.toHaveBeenCalled();
    });
  });

  describe('copyProvidedItems', () => {
    it('BP 마다 원본을 플랫폼제공 행으로 넣고, 키가 이미 있는 행은 건너뛴다 — 넣은 행 수를 돌려준다', async () => {
      tx.codeItem.createMany.mockResolvedValue({ count: 3 });
      const originals = [
        original('EMP_TYPE', 'FULL'),
        original('LEAVE_TYPE', 'SICK', 'INACTIVE'),
      ];

      await expect(
        copyProvidedItems(tx as never, originals, ['BP000001', 'BP000002'], 9),
      ).resolves.toBe(3);
      expect(tx.codeItem.createMany).toHaveBeenCalledWith({
        data: ['BP000001', 'BP000002'].flatMap((bpCode) =>
          originals.map((o) => ({
            groupCode: o.groupCode,
            bpCode,
            itemCode: o.itemCode,
            label: o.label,
            status: o.status,
            sortOrder: o.sortOrder,
            manageOwnerCode: 'PLATFORM_PROVIDED',
            createdBy: 9,
            updatedBy: 9,
          })),
        ),
        skipDuplicates: true,
      });
    });

    it('넣을 원본이나 BP 가 없으면 아무것도 하지 않는다', async () => {
      await expect(
        copyProvidedItems(tx as never, [], ['BP000001'], 9),
      ).resolves.toBe(0);
      await expect(
        copyProvidedItems(tx as never, [original('EMP_TYPE', 'FULL')], [], 9),
      ).resolves.toBe(0);
      expect(tx.codeItem.createMany).not.toHaveBeenCalled();
    });
  });
});
