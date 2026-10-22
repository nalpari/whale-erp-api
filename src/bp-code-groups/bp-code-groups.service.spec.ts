import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { BpCodeGroupsService } from './bp-code-groups.service';

// 규칙의 경계만 목으로 본다. 이 파일은 DB 없이 `pnpm test` 에서 도는 회귀 그물이다.
describe('BpCodeGroupsService', () => {
  let service: BpCodeGroupsService;
  let prisma: {
    $transaction: jest.Mock;
    bpCode: { findFirst: jest.Mock };
    codeGroup: { findMany: jest.Mock; findFirst: jest.Mock; count: jest.Mock };
    codeItem: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      createManyAndReturn: jest.Mock;
    };
  };

  const bpUser: TargetBpContext = { bpCodeId: 17, isPlatformCaller: false };
  const platformUser: TargetBpContext = {
    bpCodeId: 17,
    isPlatformCaller: true,
  };
  const providedGroup = {
    groupCode: 'EMP_TYPE',
    manageOwnerCode: 'PLATFORM_PROVIDED',
    status: 'ACTIVE',
  };
  const fixedGroup = {
    groupCode: 'ROLE_TYPE',
    manageOwnerCode: 'PLATFORM_FIXED',
    status: 'ACTIVE',
  };
  const input = (overrides: Record<string, unknown> = {}) => ({
    itemCode: 'INTERN',
    label: '수습',
    status: 'ACTIVE' as const,
    sortOrder: 5,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      bpCode: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ bpCode: 'BP000017', isPlatform: false }),
      },
      codeGroup: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(providedGroup),
        count: jest.fn().mockResolvedValue(0),
      },
      codeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        createManyAndReturn: jest.fn().mockResolvedValue([]),
      },
    };
    // 배열은 묶어 실행한 결과를, 함수는 같은 목을 트랜잭션 클라이언트로 넘긴다.
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
    );
    const module = await Test.createTestingModule({
      providers: [
        BpCodeGroupsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(BpCodeGroupsService);
  });

  describe('대상 BP', () => {
    it('플랫폼 사용자가 BP 를 고르지 않으면(가드가 플랫폼 BP 로 둔다) 400', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({
        bpCode: 'BP000000',
        isPlatform: true,
      });

      await expect(
        service.listGroups(platformUser, { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('가드 뒤에 BP 가 지워졌으면 404', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);

      await expect(
        service.listGroups(bpUser, { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
        where: { bpCodeId: 17, isDeleted: false },
        select: { bpCode: true, isPlatform: true },
      });
    });
  });

  describe('listGroups', () => {
    it('플랫폼고정과 BP 에 적용한 플랫폼제공 그룹을 사용중지 포함, 표시 순서 → 그룹 코드 순으로 한 쪽씩', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([{ groupCode: 'EMP_TYPE' }]);
      prisma.codeGroup.count.mockResolvedValue(21);

      const result = await service.listGroups(bpUser, {
        page: 2,
        pageSize: 20,
      });

      const where = {
        isDeleted: false,
        OR: [
          { manageOwnerCode: 'PLATFORM_FIXED' },
          { manageOwnerCode: 'PLATFORM_PROVIDED', isBpApplied: true },
        ],
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
      expect(result).toEqual({ items: [{ groupCode: 'EMP_TYPE' }], total: 21 });
    });

    it('그룹 코드 · 그룹명은 대소문자 없이 글자 그대로 들어 있음으로 찾는다', async () => {
      await service.listGroups(bpUser, {
        page: 1,
        pageSize: 20,
        groupCode: 'emp_',
        groupName: '고용',
      });

      const [{ where }] = prisma.codeGroup.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).toMatchObject({
        groupCode: { contains: 'emp\\_', mode: 'insensitive' },
        groupName: { contains: '고용', mode: 'insensitive' },
      });
    });
  });

  describe('listItems', () => {
    it('보이지 않는 그룹(없음 · 지움 · 미적용 플랫폼제공)은 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(
        service.listItems(bpUser, 'EMP_TYPE'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.codeGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            groupCode: 'EMP_TYPE',
            isDeleted: false,
            OR: [
              { manageOwnerCode: 'PLATFORM_FIXED' },
              { manageOwnerCode: 'PLATFORM_PROVIDED', isBpApplied: true },
            ],
          },
        }),
      );
    });

    it('플랫폼고정 그룹은 복사하지 않으므로 플랫폼 원본을 사용중지 포함으로 읽는다', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(fixedGroup);
      prisma.codeItem.findMany.mockResolvedValue([
        {
          itemCode: 'PM',
          label: '플랫폼 마스터',
          status: 'ACTIVE',
          sortOrder: 1,
          manageOwnerCode: 'PLATFORM_FIXED',
        },
        {
          itemCode: 'PA',
          label: '플랫폼 관리자',
          status: 'INACTIVE',
          sortOrder: 2,
          manageOwnerCode: 'PLATFORM_FIXED',
        },
      ]);

      const result = await service.listItems(bpUser, 'ROLE_TYPE');

      expect(prisma.codeItem.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            groupCode: 'ROLE_TYPE',
            bpCode: 'BP000000',
            isDeleted: false,
            manageOwnerCode: { not: 'BP_ONLY' },
          },
          orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        }),
      );
      expect(result.total).toBe(2);
      expect(result.items[1]).toEqual(
        expect.objectContaining({ itemCode: 'PA', isPlatformInactive: true }),
      );
      expect(result.items[0].isPlatformInactive).toBe(false);
    });

    it('플랫폼제공 그룹은 그 BP 의 행을 읽고, 플랫폼 원본이 사용중지면 표시한다(BP전용은 원본이 없다)', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([
          {
            itemCode: 'FULL',
            label: '정직원',
            status: 'ACTIVE',
            sortOrder: 1,
            manageOwnerCode: 'PLATFORM_PROVIDED',
          },
          {
            itemCode: 'CONTRACT',
            label: '계약직',
            status: 'INACTIVE',
            sortOrder: 2,
            manageOwnerCode: 'PLATFORM_PROVIDED',
          },
          {
            itemCode: 'INTERN',
            label: '수습',
            status: 'ACTIVE',
            sortOrder: 3,
            manageOwnerCode: 'BP_ONLY',
          },
        ])
        .mockResolvedValueOnce([
          { itemCode: 'FULL', status: 'ACTIVE' },
          { itemCode: 'CONTRACT', status: 'INACTIVE' },
        ]);

      const result = await service.listItems(bpUser, 'EMP_TYPE');

      expect(prisma.codeItem.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            groupCode: 'EMP_TYPE',
            bpCode: 'BP000017',
            isDeleted: false,
          },
          orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        }),
      );
      expect(prisma.codeItem.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          groupCode: 'EMP_TYPE',
          bpCode: 'BP000000',
          isDeleted: false,
          manageOwnerCode: { not: 'BP_ONLY' },
          itemCode: { in: ['FULL', 'CONTRACT', 'INTERN'] },
        },
        select: { itemCode: true, status: true },
      });
      expect(result).toEqual({
        items: [
          expect.objectContaining({
            itemCode: 'FULL',
            isPlatformInactive: false,
          }),
          expect.objectContaining({
            itemCode: 'CONTRACT',
            isPlatformInactive: true,
          }),
          expect.objectContaining({
            itemCode: 'INTERN',
            manageOwnerCode: 'BP_ONLY',
            isPlatformInactive: false,
          }),
        ],
        total: 3,
      });
    });
  });

  describe('createItems', () => {
    it('플랫폼 사용자는 조회만 한다 — 403', async () => {
      await expect(
        service.createItems(1, platformUser, 'EMP_TYPE', [input()]),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('플랫폼고정 그룹은 409', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(fixedGroup);

      await expect(
        service.createItems(1, bpUser, 'ROLE_TYPE', [input()]),
      ).rejects.toThrow('플랫폼고정 그룹은 조회만 할 수 있습니다');
    });

    it('사용 중지된 그룹은 409', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue({
        ...providedGroup,
        status: 'INACTIVE',
      });

      await expect(
        service.createItems(1, bpUser, 'EMP_TYPE', [input()]),
      ).rejects.toThrow(
        '사용 중지된 그룹은 상세 코드를 추가하거나 고칠 수 없습니다',
      );
    });

    it('한 요청에 같은 코드가 두 번이면 DB 에 묻기 전에 409 — 이미 있는 코드와 다른 문구로', async () => {
      await expect(
        service.createItems(1, bpUser, 'EMP_TYPE', [input(), input()]),
      ).rejects.toThrow('한 요청에 같은 상세 코드가 두 번 있습니다: INTERN');
      expect(prisma.codeItem.findMany).not.toHaveBeenCalled();
    });

    it('같은 그룹의 플랫폼 원본(지운 것 포함)과 겹치면 409 — 그 사실을 문구로 알린다', async () => {
      prisma.codeItem.findMany.mockResolvedValue([
        { itemCode: 'PART', bpCode: 'BP000000' },
      ]);

      await expect(
        service.createItems(1, bpUser, 'EMP_TYPE', [
          input({ itemCode: 'PART' }),
        ]),
      ).rejects.toThrow('플랫폼이 등록한 상세 코드와 겹칩니다: PART');
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith({
        where: {
          groupCode: 'EMP_TYPE',
          itemCode: { in: ['PART'] },
          bpCode: { in: ['BP000017', 'BP000000'] },
        },
        select: { itemCode: true, bpCode: true },
      });
      expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('그 BP 가 가진 행(지운 것 포함)과 겹치면 409', async () => {
      prisma.codeItem.findMany.mockResolvedValue([
        { itemCode: 'INTERN', bpCode: 'BP000017' },
      ]);

      await expect(
        service.createItems(1, bpUser, 'EMP_TYPE', [input()]),
      ).rejects.toThrow('이 그룹에 이미 있는 상세 코드입니다: INTERN');
    });

    it('그 BP 의 BP전용 행으로 만든다', async () => {
      prisma.codeItem.createManyAndReturn.mockResolvedValue([
        { itemCode: 'INTERN' },
      ]);

      await service.createItems(7, bpUser, 'EMP_TYPE', [input()]);

      expect(prisma.codeItem.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            groupCode: 'EMP_TYPE',
            bpCode: 'BP000017',
            itemCode: 'INTERN',
            label: '수습',
            status: 'ACTIVE',
            sortOrder: 5,
            manageOwnerCode: 'BP_ONLY',
            createdBy: 7,
            updatedBy: 7,
          },
        ],
        select: { itemCode: true },
        skipDuplicates: true,
      });
    });

    it('확인 뒤 끼어든 같은 코드는 500 이 아니라 409 — 만들지 못한 코드만 알린다', async () => {
      prisma.codeItem.createManyAndReturn.mockResolvedValue([
        { itemCode: 'INTERN' },
      ]);

      await expect(
        service.createItems(1, bpUser, 'EMP_TYPE', [
          input(),
          input({ itemCode: 'TEMP' }),
        ]),
      ).rejects.toThrow('이 그룹에 이미 있는 상세 코드입니다: TEMP');
    });
  });

  describe('updateItems', () => {
    const bpRow = (overrides: Record<string, unknown> = {}) => ({
      itemCode: 'FULL',
      status: 'ACTIVE',
      ...overrides,
    });

    it('플랫폼 사용자는 403', async () => {
      await expect(
        service.updateItems(1, platformUser, 'EMP_TYPE', [input()]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('플랫폼고정 그룹 · 사용 중지된 그룹은 409', async () => {
      prisma.codeGroup.findFirst.mockResolvedValueOnce(fixedGroup);
      await expect(
        service.updateItems(1, bpUser, 'ROLE_TYPE', [input()]),
      ).rejects.toBeInstanceOf(ConflictException);

      prisma.codeGroup.findFirst.mockResolvedValueOnce({
        ...providedGroup,
        status: 'INACTIVE',
      });
      await expect(
        service.updateItems(1, bpUser, 'EMP_TYPE', [input()]),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('한 요청에 같은 코드가 두 번이면 409', async () => {
      await expect(
        service.updateItems(1, bpUser, 'EMP_TYPE', [input(), input()]),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('그 BP 의 지우지 않은 행이 아니면 404 — 아무것도 고치지 않는다', async () => {
      prisma.codeItem.findMany.mockResolvedValueOnce([bpRow()]);

      await expect(
        service.updateItems(1, bpUser, 'EMP_TYPE', [
          input({ itemCode: 'FULL' }),
          input({ itemCode: 'GHOST' }),
        ]),
      ).rejects.toThrow('상세 코드를 찾을 수 없습니다: GHOST');
      expect(prisma.codeItem.findMany).toHaveBeenNthCalledWith(1, {
        where: {
          groupCode: 'EMP_TYPE',
          bpCode: 'BP000017',
          isDeleted: false,
          itemCode: { in: ['FULL', 'GHOST'] },
        },
        select: { itemCode: true, status: true },
      });
      expect(prisma.codeItem.update).not.toHaveBeenCalled();
    });

    it('플랫폼이 사용 중지한 코드를 사용으로 켜면 409', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([
          bpRow({ itemCode: 'CONTRACT', status: 'INACTIVE' }),
        ])
        .mockResolvedValueOnce([{ itemCode: 'CONTRACT', status: 'INACTIVE' }]);

      await expect(
        service.updateItems(1, bpUser, 'EMP_TYPE', [
          input({ itemCode: 'CONTRACT', status: 'ACTIVE' }),
        ]),
      ).rejects.toThrow(
        '플랫폼이 사용 중지한 코드는 다시 사용으로 바꿀 수 없습니다: CONTRACT',
      );
      expect(prisma.codeItem.update).not.toHaveBeenCalled();
    });

    it('이미 사용 중인 행은 원본이 사용중지여도 그대로 저장한다 — 패널 전체를 다시 보내도 막히지 않게', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([bpRow({ itemCode: 'CONTRACT' })])
        .mockResolvedValueOnce([{ itemCode: 'CONTRACT', status: 'INACTIVE' }]);

      await service.updateItems(7, bpUser, 'EMP_TYPE', [
        input({ itemCode: 'CONTRACT', status: 'ACTIVE' }),
      ]);

      // 읽은 뒤 다른 관리자가 끄면 켜는 셈이 되므로, 지금도 사용 중일 때만 쓰는 조건부 UPDATE 다.
      expect(prisma.codeItem.updateMany).toHaveBeenCalledWith({
        where: {
          groupCode: 'EMP_TYPE',
          itemCode: 'CONTRACT',
          bpCode: 'BP000017',
          status: 'ACTIVE',
        },
        data: { label: '수습', status: 'ACTIVE', sortOrder: 5, updatedBy: 7 },
      });
      expect(prisma.codeItem.update).not.toHaveBeenCalled();
    });

    it('읽은 뒤 다른 관리자가 그 코드를 껐으면(조건부 UPDATE 0건) 다시 켜지 않고 409', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([bpRow({ itemCode: 'CONTRACT' })])
        .mockResolvedValueOnce([{ itemCode: 'CONTRACT', status: 'INACTIVE' }]);
      prisma.codeItem.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateItems(1, bpUser, 'EMP_TYPE', [
          input({ itemCode: 'CONTRACT', status: 'ACTIVE' }),
        ]),
      ).rejects.toThrow(
        '플랫폼이 사용 중지한 코드는 다시 사용으로 바꿀 수 없습니다: CONTRACT',
      );
    });

    it('그 BP 의 행만 코드명 · 사용 상태 · 표시 순서를 고친다', async () => {
      prisma.codeItem.findMany
        .mockResolvedValueOnce([bpRow({ status: 'INACTIVE' })])
        .mockResolvedValueOnce([{ itemCode: 'FULL', status: 'ACTIVE' }]);

      await service.updateItems(7, bpUser, 'EMP_TYPE', [
        input({ itemCode: 'FULL', label: '정규직', sortOrder: 2 }),
      ]);

      expect(prisma.codeItem.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          groupCode: 'EMP_TYPE',
          bpCode: 'BP000000',
          isDeleted: false,
          manageOwnerCode: { not: 'BP_ONLY' },
          itemCode: { in: ['FULL'] },
        },
        select: { itemCode: true, status: true },
      });
      expect(prisma.codeItem.update).toHaveBeenCalledWith({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: 'EMP_TYPE',
            itemCode: 'FULL',
            bpCode: 'BP000017',
          },
        },
        data: { label: '정규직', status: 'ACTIVE', sortOrder: 2, updatedBy: 7 },
      });
    });
  });
});
