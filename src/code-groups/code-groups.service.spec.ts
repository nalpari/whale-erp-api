import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CodeGroupsService } from './code-groups.service';

// 규칙의 경계만 목으로 본다. 이 파일은 DB 없이 `pnpm test` 에서 도는 회귀 그물이다.
describe('CodeGroupsService', () => {
  let service: CodeGroupsService;
  let prisma: {
    $transaction: jest.Mock;
    adminAccount: { findFirst: jest.Mock };
    codeGroup: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      createMany: jest.Mock;
    };
    codeItem: {
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      createMany: jest.Mock;
    };
    bpCode: { findMany: jest.Mock };
  };

  const group = (overrides: Record<string, unknown> = {}) => ({
    groupCode: 'EMP_TYPE',
    manageOwnerCode: 'PLATFORM_PROVIDED',
    isDeleted: false,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleTypeCode: 'PA' }),
      },
      codeGroup: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(group()),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      codeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      bpCode: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // 배열은 묶어 실행한 결과를, 함수는 같은 목을 트랜잭션 클라이언트로 넘긴다.
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
    );
    const module = await Test.createTestingModule({
      providers: [
        CodeGroupsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(CodeGroupsService);
  });

  describe('assertPlatformAdmin', () => {
    const mockAdmin = (row: Record<string, unknown> | null) => {
      prisma.adminAccount.findFirst.mockResolvedValue(row);
    };

    it.each(['PM', 'PA'])('%s 는 통과한다', async (roleTypeCode) => {
      mockAdmin({ roleTypeCode });
      await expect(service.assertPlatformAdmin(9)).resolves.toBeUndefined();
    });

    it.each(['BM', 'BA', 'FM', 'FA'])('%s 는 403', async (roleTypeCode) => {
      mockAdmin({ roleTypeCode });
      await expect(service.assertPlatformAdmin(9)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('없는 관리자는 403', async () => {
      mockAdmin(null);
      await expect(service.assertPlatformAdmin(9)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    // 관리자 토큰은 가드가 DB 를 보지 않으므로, 계정이 막혀도 토큰이 살아 있는 동안 여기까지 온다.
    it.each([
      ['삭제된', { isDeleted: true, accountStatusCode: 'ACTIVE' }],
      ['사용중지된', { isDeleted: false, accountStatusCode: 'INACTIVE' }],
      ['탈퇴한', { isDeleted: false, accountStatusCode: 'WITHDRAWN' }],
    ])('%s 플랫폼 관리자는 403', async (_, state) => {
      const row = { adminAccountId: 9, roleTypeCode: 'PA', ...state };
      // where 의 조건을 행에 그대로 대 보는 가짜 조회 — 조건을 빠뜨리면 행이 돌아온다.
      const lookup = ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          Object.entries(where).every(([k, v]) => row[k] === v) ? row : null,
        );
      prisma.adminAccount.findFirst.mockImplementation(lookup);

      await expect(service.assertPlatformAdmin(9)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
    it('다른 관리자가 플랫폼 관리자여도 내 계정이 아니면 403', async () => {
      const row = {
        adminAccountId: 1,
        roleTypeCode: 'PM',
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      };
      prisma.adminAccount.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            Object.entries(where).every(([k, v]) => row[k] === v) ? row : null,
          ),
      );

      await expect(service.assertPlatformAdmin(9)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('listGroups', () => {
    it('플랫폼고정·플랫폼제공의 지우지 않은 그룹만, 표시 순서 → 그룹 코드 순으로 한 쪽씩', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([{ groupCode: 'SERVICE' }]);
      prisma.codeGroup.count.mockResolvedValue(21);

      const result = await service.listGroups({ page: 2, pageSize: 20 });

      const where = {
        isDeleted: false,
        manageOwnerCode: { in: ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'] },
      };
      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.codeGroup.count).toHaveBeenCalledWith({ where });
      expect(result).toEqual({ items: [{ groupCode: 'SERVICE' }], total: 21 });
    });
  });

  describe('saveGroups', () => {
    const update = {
      groupCode: 'EMP_TYPE',
      groupName: '고용 형태',
      status: 'ACTIVE' as const,
      sortOrder: 1,
    };
    const create = {
      groupCode: 'BANK',
      groupName: '은행',
      manageOwnerCode: 'PLATFORM_PROVIDED' as const,
      status: 'ACTIVE' as const,
      sortOrder: 2,
    };

    it('기존 그룹은 그룹명·사용 상태·표시 순서만 고치고, 새 그룹은 미적용으로 만든다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group()]);
      prisma.codeGroup.createMany.mockResolvedValue({ count: 1 });

      await service.saveGroups(9, { updates: [update], creates: [create] });

      expect(prisma.codeGroup.update).toHaveBeenCalledWith({
        where: { groupCode: 'EMP_TYPE' },
        data: {
          groupName: '고용 형태',
          status: 'ACTIVE',
          sortOrder: 1,
          updatedBy: 9,
        },
      });
      expect(prisma.codeGroup.createMany).toHaveBeenCalledWith({
        data: [
          {
            ...create,
            isBpApplied: false,
            createdBy: 9,
            updatedBy: 9,
          },
        ],
        skipDuplicates: true,
      });
    });

    it('이미 있는 그룹 코드로 만들면 409 — 지운 그룹의 코드도 다시 쓰지 않는다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([
        group({ groupCode: 'BANK', isDeleted: true }),
      ]);

      await expect(
        service.saveGroups(9, { updates: [], creates: [create] }),
      ).rejects.toThrow(
        new ConflictException('이미 있는 그룹 코드입니다: BANK'),
      );
      expect(prisma.codeGroup.createMany).not.toHaveBeenCalled();
    });

    it('확인 뒤 다른 관리자가 같은 그룹 코드를 먼저 넣었으면 500 이 아니라 409', async () => {
      // 두 요청이 모두 「없음」을 읽은 뒤, 늦은 쪽의 INSERT 는 키가 겹쳐 건너뛰어진다.
      prisma.codeGroup.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.saveGroups(9, { updates: [], creates: [create] }),
      ).rejects.toThrow(
        new ConflictException('이미 있는 그룹 코드입니다: BANK'),
      );
      expect(prisma.codeGroup.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('한 요청 안에서 같은 그룹 코드를 두 번 만들면 409', async () => {
      await expect(
        service.saveGroups(9, { updates: [], creates: [create, create] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('없거나 지운 그룹을 고치면 404', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group({ isDeleted: true })]);

      await expect(
        service.saveGroups(9, { updates: [update], creates: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.codeGroup.update).not.toHaveBeenCalled();
    });

    it('BP전용 그룹은 고칠 수 없다(404)', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([
        group({ manageOwnerCode: 'BP_ONLY' }),
      ]);

      await expect(
        service.saveGroups(9, { updates: [update], creates: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listItems', () => {
    it('플랫폼 원본(BP000000) 중 BP전용이 아닌 지우지 않은 상세 코드만 표시 순서 → 코드 순', async () => {
      prisma.codeItem.findMany.mockResolvedValue([{ itemCode: 'FULL' }]);
      prisma.codeItem.count.mockResolvedValue(1);

      const result = await service.listItems('EMP_TYPE');

      const where = {
        groupCode: 'EMP_TYPE',
        bpCode: 'BP000000',
        isDeleted: false,
        manageOwnerCode: { not: 'BP_ONLY' },
      };
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        }),
      );
      expect(result).toEqual({ items: [{ itemCode: 'FULL' }], total: 1 });
    });

    it('없는 그룹이면 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(service.listItems('NOPE')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('saveItems', () => {
    const update = {
      itemCode: 'FULL',
      label: '정규직',
      status: 'INACTIVE' as const,
      sortOrder: 2,
    };
    const create = {
      itemCode: 'INTERN',
      label: '인턴',
      status: 'ACTIVE' as const,
      sortOrder: 3,
    };

    it('기존 코드는 코드명·사용 상태·표시 순서만 고치고, 새 코드는 그룹의 관리 주체로 플랫폼 원본에 만든다', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([{ itemCode: 'FULL' }]) // 고칠 대상
        .mockResolvedValueOnce([]); // 새 코드와 겹치는 행
      prisma.codeItem.createMany.mockResolvedValue({ count: 1 });

      await service.saveItems(9, 'EMP_TYPE', {
        updates: [update],
        creates: [create],
      });

      expect(prisma.codeItem.update).toHaveBeenCalledWith({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: 'EMP_TYPE',
            itemCode: 'FULL',
            bpCode: 'BP000000',
          },
        },
        data: {
          label: '정규직',
          status: 'INACTIVE',
          sortOrder: 2,
          updatedBy: 9,
        },
      });
      expect(prisma.codeItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            ...create,
            groupCode: 'EMP_TYPE',
            bpCode: 'BP000000',
            manageOwnerCode: 'PLATFORM_PROVIDED',
            createdBy: 9,
            updatedBy: 9,
          },
        ],
        skipDuplicates: true,
      });
    });

    it('같은 그룹에 이미 있는 상세 코드면 409 — BP별 행·BP전용 코드와도 겹칠 수 없다', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ itemCode: 'INTERN' }]);

      await expect(
        service.saveItems(9, 'EMP_TYPE', { updates: [], creates: [create] }),
      ).rejects.toThrow(
        new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
      );
      expect(prisma.codeItem.createMany).not.toHaveBeenCalled();
    });

    it('확인 뒤 다른 관리자가 같은 상세 코드를 먼저 넣었으면 500 이 아니라 409', async () => {
      prisma.codeItem.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.saveItems(9, 'EMP_TYPE', { updates: [], creates: [create] }),
      ).rejects.toThrow(
        new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
      );
      expect(prisma.codeItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('한 요청 안에서 같은 상세 코드를 두 번 만들면 409', async () => {
      await expect(
        service.saveItems(9, 'EMP_TYPE', {
          updates: [],
          creates: [create, create],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('플랫폼 원본에 없는 코드(BP전용 등)를 고치면 404', async () => {
      prisma.codeItem.findMany.mockResolvedValueOnce([]);

      await expect(
        service.saveItems(9, 'EMP_TYPE', { updates: [update], creates: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.codeItem.update).not.toHaveBeenCalled();
    });

    it('없는 그룹이면 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(
        service.saveItems(9, 'NOPE', { updates: [], creates: [create] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('applyToBps', () => {
    const originals = [
      { itemCode: 'FULL', label: '정규직', status: 'ACTIVE', sortOrder: 1 },
      { itemCode: 'PART', label: '파트', status: 'INACTIVE', sortOrder: 2 },
    ];

    beforeEach(() => {
      prisma.codeItem.findMany.mockResolvedValue(originals);
      prisma.bpCode.findMany.mockResolvedValue([
        { bpCode: 'BP000001' },
        { bpCode: 'BP000002' },
      ]);
    });

    it('사용 중인 고객 BP 에 원본 중 없는 행만 넣고, 이미 있는 행(BP가 고친 행 · BP전용 행)은 건너뛴다', async () => {
      // BP000001 에는 FULL 이 이미 있어 3행만 들어갔다고 DB 가 답한다.
      prisma.codeItem.createMany.mockResolvedValue({ count: 3 });

      const result = await service.applyToBps(9, 'EMP_TYPE');

      expect(prisma.bpCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isPlatform: false,
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
          },
        }),
      );
      expect(prisma.codeItem.createMany).toHaveBeenCalledWith({
        data: ['BP000001', 'BP000002'].flatMap((bpCode) =>
          originals.map((o) => ({
            groupCode: 'EMP_TYPE',
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
      // 있는 행은 덮어쓰지 않는다
      expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.codeItem.update).not.toHaveBeenCalled();
      expect(prisma.codeGroup.update).toHaveBeenCalledWith({
        where: { groupCode: 'EMP_TYPE' },
        data: { isBpApplied: true, updatedBy: 9 },
      });
      expect(result).toEqual({ bpCount: 2, itemCount: 2, createdCount: 3 });
    });

    it('이미 적용한 그룹도 다시 적용할 수 있다 — 그 뒤 추가한 상세 코드만 들어간다', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(
        group({ isBpApplied: true }),
      );
      prisma.codeItem.createMany.mockResolvedValue({ count: 2 });

      await expect(service.applyToBps(9, 'EMP_TYPE')).resolves.toEqual({
        bpCount: 2,
        itemCount: 2,
        createdCount: 2,
      });
      expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
    });

    // 적용은 되돌릴 수 없다. 넣은 행이 없는 채로 「적용됨」에 갇히지 않게 쓰기 전에 409 로 막는다.
    it('사용 중인 고객 BP 가 없으면 409 — 적용으로 표시하지 않는다', async () => {
      prisma.bpCode.findMany.mockResolvedValue([]);

      await expect(service.applyToBps(9, 'EMP_TYPE')).rejects.toThrow(
        new ConflictException('적용할 사용 중인 고객 BP 가 없습니다'),
      );
      expect(prisma.codeItem.createMany).not.toHaveBeenCalled();
      expect(prisma.codeGroup.update).not.toHaveBeenCalled();
    });

    it('상세 코드가 없는 그룹이면 409 — 적용으로 표시하지 않는다', async () => {
      prisma.codeItem.findMany.mockResolvedValue([]);

      await expect(service.applyToBps(9, 'EMP_TYPE')).rejects.toThrow(
        new ConflictException(
          '상세 코드가 없는 그룹은 BP에 적용할 수 없습니다',
        ),
      );
      expect(prisma.codeItem.createMany).not.toHaveBeenCalled();
      expect(prisma.codeGroup.update).not.toHaveBeenCalled();
    });

    it('BP 수 × 상세 코드 수만큼 넣으므로 트랜잭션 기본 timeout(5초)보다 길게 연다', async () => {
      await service.applyToBps(9, 'EMP_TYPE');

      const calls = prisma.$transaction.mock.calls as unknown[][];
      const options = calls.at(-1)?.[1] as { timeout?: number } | undefined;
      expect(options?.timeout).toBeGreaterThan(5_000);
    });

    it('플랫폼고정 그룹은 409', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(
        group({ manageOwnerCode: 'PLATFORM_FIXED' }),
      );

      await expect(service.applyToBps(9, 'ROLE_TYPE')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.codeItem.createMany).not.toHaveBeenCalled();
    });

    it('없는 그룹이면 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(service.applyToBps(9, 'NOPE')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
