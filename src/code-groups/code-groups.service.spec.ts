import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CodeGroupsService } from './code-groups.service';

// 규칙의 경계만 목으로 본다. 이 파일은 DB 없이 `pnpm test` 에서 도는 회귀 그물이다.
describe('CodeGroupsService', () => {
  let service: CodeGroupsService;
  let prisma: {
    $transaction: jest.Mock;
    codeGroup: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      createManyAndReturn: jest.Mock;
    };
    codeItem: {
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      createMany: jest.Mock;
      createManyAndReturn: jest.Mock;
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
      codeGroup: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(group()),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        createManyAndReturn: jest.fn().mockResolvedValue([]),
      },
      codeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        createManyAndReturn: jest.fn().mockResolvedValue([]),
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

    it('그룹 코드 · 그룹명은 대소문자 없이 글자 그대로 들어 있음으로 찾는다 — 목록과 건수에 같은 조건', async () => {
      await service.listGroups({
        page: 1,
        pageSize: 20,
        groupCode: 'emp_',
        groupName: '고용',
      });

      const where = {
        isDeleted: false,
        manageOwnerCode: { in: ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'] },
        groupCode: { contains: 'emp\\_', mode: 'insensitive' },
        groupName: { contains: '고용', mode: 'insensitive' },
      };
      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.codeGroup.count).toHaveBeenCalledWith({ where });
    });
  });

  describe('그룹 등록 · 수정', () => {
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

    describe('createGroups', () => {
      it('새 그룹은 미적용으로 만들고, 기존 그룹은 건드리지 않는다', async () => {
        prisma.codeGroup.createManyAndReturn.mockResolvedValue([
          { groupCode: 'BANK' },
        ]);

        await service.createGroups(9, [create]);

        expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { groupCode: { in: ['BANK'] } } }),
        );
        expect(prisma.codeGroup.createManyAndReturn).toHaveBeenCalledWith({
          data: [
            {
              ...create,
              isBpApplied: false,
              createdBy: 9,
              updatedBy: 9,
            },
          ],
          select: { groupCode: true },
          skipDuplicates: true,
        });
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });

      it('이미 있는 그룹 코드로 만들면 409 — 지운 그룹의 코드도 다시 쓰지 않는다', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([
          group({ groupCode: 'BANK', isDeleted: true }),
        ]);

        await expect(service.createGroups(9, [create])).rejects.toThrow(
          new ConflictException('이미 있는 그룹 코드입니다: BANK'),
        );
        expect(prisma.codeGroup.createManyAndReturn).not.toHaveBeenCalled();
      });

      it('확인 뒤 다른 관리자가 같은 그룹 코드를 먼저 넣었으면 500 이 아니라 409', async () => {
        // 두 요청이 모두 「없음」을 읽은 뒤, 늦은 쪽의 INSERT 는 키가 겹쳐 건너뛰어진다.
        prisma.codeGroup.createManyAndReturn.mockResolvedValue([]);

        await expect(service.createGroups(9, [create])).rejects.toThrow(
          new ConflictException('이미 있는 그룹 코드입니다: BANK'),
        );
        expect(prisma.codeGroup.createManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({ skipDuplicates: true }),
        );
      });

      it('경합의 409 는 이번 INSERT 가 만들지 못한(먼저 들어간) 코드만 알린다', async () => {
        // 2행 중 BANK 만 들어갔다 — 일부만 막혀도 409 이고, 메시지에는 겹친 CARD 만 싣는다.
        prisma.codeGroup.createManyAndReturn.mockResolvedValue([
          { groupCode: 'BANK' },
        ]);

        await expect(
          service.createGroups(9, [create, { ...create, groupCode: 'CARD' }]),
        ).rejects.toThrow(
          new ConflictException('이미 있는 그룹 코드입니다: CARD'),
        );
      });

      it('한 요청 안에서 같은 그룹 코드를 두 번 만들면 DB 에 묻기 전에 409', async () => {
        await expect(service.createGroups(9, [create, create])).rejects.toThrow(
          new ConflictException('이미 있는 그룹 코드입니다: BANK'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('updateGroups', () => {
      // 최대 200행을 한 행씩 고쳐 원격 DB 에서는 Prisma 기본 5초를 넘길 수 있다.
      it('트랜잭션 시간 제한을 늘려 둔다', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([group()]);

        await service.updateGroups(9, [update]);

        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          timeout: 30_000,
          maxWait: 5_000,
        });
      });

      it('그룹명·사용 상태·표시 순서만 고치고, 새 그룹은 만들지 않는다', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([group()]);

        await service.updateGroups(9, [update]);

        expect(prisma.codeGroup.update).toHaveBeenCalledWith({
          where: { groupCode: 'EMP_TYPE' },
          data: {
            groupName: '고용 형태',
            status: 'ACTIVE',
            sortOrder: 1,
            updatedBy: 9,
          },
        });
        expect(prisma.codeGroup.createManyAndReturn).not.toHaveBeenCalled();
      });

      it('플랫폼고정 그룹도 고칠 수 있다', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([
          group({ manageOwnerCode: 'PLATFORM_FIXED' }),
        ]);

        await service.updateGroups(9, [update]);

        expect(prisma.codeGroup.update).toHaveBeenCalledTimes(1);
      });

      it('한 요청 안에서 같은 그룹 코드를 두 번 고치면 DB 에 묻기 전에 409', async () => {
        await expect(service.updateGroups(9, [update, update])).rejects.toThrow(
          new ConflictException(
            '한 요청에 같은 그룹 코드가 두 번 있습니다: EMP_TYPE',
          ),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('없거나 지운 그룹을 고치면 404', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([
          group({ isDeleted: true }),
        ]);

        await expect(service.updateGroups(9, [update])).rejects.toThrow(
          new NotFoundException('공통코드 그룹을 찾을 수 없습니다: EMP_TYPE'),
        );
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });

      it('BP전용 그룹은 고칠 수 없다(404)', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([
          group({ manageOwnerCode: 'BP_ONLY' }),
        ]);

        await expect(service.updateGroups(9, [update])).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });

      it('여러 행 중 하나라도 없으면 아무것도 고치지 않는다', async () => {
        prisma.codeGroup.findMany.mockResolvedValue([group()]);

        await expect(
          service.updateGroups(9, [update, { ...update, groupCode: 'NOPE' }]),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });
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

  describe('상세 코드 등록 · 수정', () => {
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

    describe('createItems', () => {
      it('새 코드는 그룹의 관리 주체로 플랫폼 원본에 만들고, 기존 코드는 건드리지 않는다', async () => {
        prisma.codeGroup.findFirst.mockResolvedValue(
          group({ manageOwnerCode: 'PLATFORM_FIXED' }),
        );
        prisma.codeItem.createManyAndReturn.mockResolvedValue([
          { itemCode: 'INTERN' },
        ]);

        await service.createItems(9, 'EMP_TYPE', [create]);

        // 이 화면의 그룹은 지우지 않은 플랫폼고정 · 플랫폼제공뿐이다.
        expect(prisma.codeGroup.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              groupCode: 'EMP_TYPE',
              isDeleted: false,
              manageOwnerCode: { in: ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'] },
            },
          }),
        );
        // 같은 그룹의 모든 BP 행 · 원본을 읽고, 겹침은 살아 있는 행으로만 판정한다(지운 행은 되살린다).
        expect(prisma.codeItem.findMany).toHaveBeenCalledWith({
          where: { groupCode: 'EMP_TYPE', itemCode: { in: ['INTERN'] } },
          select: { itemCode: true, bpCode: true, isDeleted: true },
        });
        expect(prisma.codeItem.createManyAndReturn).toHaveBeenCalledWith({
          data: [
            {
              ...create,
              groupCode: 'EMP_TYPE',
              bpCode: 'BP000000',
              manageOwnerCode: 'PLATFORM_FIXED',
              createdBy: 9,
              updatedBy: 9,
            },
          ],
          select: { itemCode: true },
          skipDuplicates: true,
        });
        expect(prisma.codeItem.update).not.toHaveBeenCalled();
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });

      it('같은 그룹의 살아 있는 행과 겹치면 409 — 원본 · BP별 행 · BP전용 모두, 겹친 코드를 요청 순서대로', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'TEMP', bpCode: 'BP000017', isDeleted: false },
          { itemCode: 'INTERN', bpCode: 'BP000000', isDeleted: false },
          { itemCode: 'INTERN', bpCode: 'BP000017', isDeleted: false },
        ]);

        await expect(
          service.createItems(9, 'EMP_TYPE', [
            create,
            { ...create, itemCode: 'TEMP' },
          ]),
        ).rejects.toThrow(
          new ConflictException(
            '이 그룹에 이미 있는 상세 코드입니다: INTERN, TEMP',
          ),
        );
        expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });

      // 되살리기는 최대 500행을 한 행씩 고친다 — 수정처럼 Prisma 기본 5초를 넘길 수 있다.
      it('트랜잭션 시간 제한을 늘려 둔다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'INTERN', bpCode: 'BP000000', isDeleted: true },
        ]);
        prisma.codeItem.updateMany.mockResolvedValue({ count: 1 });

        await service.createItems(9, 'EMP_TYPE', [create]);

        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          timeout: 30_000,
          maxWait: 5_000,
        });
      });

      it('지운 원본과 같은 코드면 그 원본의 논리 삭제를 풀고 요청 값으로 되살린다 — 새 행은 만들지 않는다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'INTERN', bpCode: 'BP000000', isDeleted: true },
        ]);
        prisma.codeItem.updateMany.mockResolvedValue({ count: 1 });

        await service.createItems(9, 'EMP_TYPE', [create]);

        expect(prisma.codeItem.updateMany).toHaveBeenCalledWith({
          where: {
            groupCode: 'EMP_TYPE',
            itemCode: 'INTERN',
            bpCode: 'BP000000',
            isDeleted: true,
          },
          data: {
            label: '인턴',
            status: 'ACTIVE',
            sortOrder: 3,
            isDeleted: false,
            updatedBy: 9,
          },
        });
        expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
      });

      it('BP 에서 지운 행만 있으면 겹침이 아니다 — 원본을 새로 만든다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'INTERN', bpCode: 'BP000017', isDeleted: true },
        ]);
        prisma.codeItem.createManyAndReturn.mockResolvedValue([
          { itemCode: 'INTERN' },
        ]);

        await service.createItems(9, 'EMP_TYPE', [create]);

        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
        expect(prisma.codeItem.createManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            data: [expect.objectContaining({ itemCode: 'INTERN' })],
          }),
        );
      });

      it('살아 있는 행과 지운 원본이 함께 겹치면 409 — 아무것도 되살리지 않는다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'TEMP', bpCode: 'BP000000', isDeleted: true },
          { itemCode: 'INTERN', bpCode: 'BP000017', isDeleted: false },
        ]);

        await expect(
          service.createItems(9, 'EMP_TYPE', [
            { ...create, itemCode: 'TEMP' },
            create,
          ]),
        ).rejects.toThrow(
          new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
        );
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });

      it('확인 뒤 다른 관리자가 같은 지운 코드를 먼저 되살렸으면(되살린 행 0건) 409', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'INTERN', bpCode: 'BP000000', isDeleted: true },
        ]);
        prisma.codeItem.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          service.createItems(9, 'EMP_TYPE', [create]),
        ).rejects.toThrow(
          new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
        );
      });

      it('확인 뒤 다른 관리자가 같은 상세 코드를 먼저 넣었으면 500 이 아니라 409', async () => {
        prisma.codeItem.createManyAndReturn.mockResolvedValue([]);

        await expect(
          service.createItems(9, 'EMP_TYPE', [create]),
        ).rejects.toThrow(
          new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
        );
        expect(prisma.codeItem.createManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({ skipDuplicates: true }),
        );
      });

      it('경합의 409 는 이번 INSERT 가 만들지 못한(먼저 들어간) 코드만 알린다', async () => {
        prisma.codeItem.createManyAndReturn.mockResolvedValue([
          { itemCode: 'INTERN' },
        ]);

        await expect(
          service.createItems(9, 'EMP_TYPE', [
            create,
            { ...create, itemCode: 'TEMP' },
          ]),
        ).rejects.toThrow(
          new ConflictException('이 그룹에 이미 있는 상세 코드입니다: TEMP'),
        );
      });

      it('한 요청 안에서 같은 상세 코드를 두 번 만들면 DB 에 쓰기 전에 409', async () => {
        await expect(
          service.createItems(9, 'EMP_TYPE', [create, create]),
        ).rejects.toThrow(
          new ConflictException('이 그룹에 이미 있는 상세 코드입니다: INTERN'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('없는 그룹이면 404', async () => {
        prisma.codeGroup.findFirst.mockResolvedValue(null);

        await expect(
          service.createItems(9, 'NOPE', [create]),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
      });
    });

    describe('updateItems', () => {
      // 최대 500행을 한 행씩 고쳐 원격 DB 에서는 Prisma 기본 5초를 넘길 수 있다.
      it('트랜잭션 시간 제한을 늘려 둔다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([{ itemCode: 'FULL' }]);
        prisma.codeItem.updateMany.mockResolvedValue({ count: 1 });

        await service.updateItems(9, 'EMP_TYPE', [update]);

        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          timeout: 30_000,
          maxWait: 5_000,
        });
      });

      it('코드명·사용 상태·표시 순서만 고치고, 새 코드는 만들지 않는다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([{ itemCode: 'FULL' }]);
        prisma.codeItem.updateMany.mockResolvedValue({ count: 1 });

        await service.updateItems(9, 'EMP_TYPE', [update]);

        expect(prisma.codeItem.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              groupCode: 'EMP_TYPE',
              bpCode: 'BP000000',
              isDeleted: false,
              manageOwnerCode: { not: 'BP_ONLY' },
              itemCode: { in: ['FULL'] },
            },
          }),
        );
        expect(prisma.codeItem.updateMany).toHaveBeenCalledWith({
          where: {
            groupCode: 'EMP_TYPE',
            itemCode: 'FULL',
            bpCode: 'BP000000',
            isDeleted: false,
            manageOwnerCode: { not: 'BP_ONLY' },
          },
          data: {
            label: '정규직',
            status: 'INACTIVE',
            sortOrder: 2,
            updatedBy: 9,
          },
        });
        expect(prisma.codeItem.createManyAndReturn).not.toHaveBeenCalled();
      });

      // 확인 뒤 다른 관리자가 같은 코드를 지우면 지운 행을 고치지 않는다 — 지운 행에 쓰면 저장은 성공인데 화면에는
      // 보이지 않는다. 0건이면 트랜잭션째 409 로 되돌린다.
      it('확인 뒤 다른 관리자가 먼저 지운 코드가 있으면(고친 행 0건) 409', async () => {
        prisma.codeItem.findMany.mockResolvedValue([
          { itemCode: 'FULL' },
          { itemCode: 'PART' },
        ]);
        prisma.codeItem.updateMany
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 });

        await expect(
          service.updateItems(9, 'EMP_TYPE', [
            update,
            { ...update, itemCode: 'PART' },
          ]),
        ).rejects.toThrow(
          new ConflictException(
            '다른 관리자가 먼저 지운 상세 코드가 있습니다 — 다시 불러온 뒤 저장해 주세요: PART',
          ),
        );
      });

      it('한 요청 안에서 같은 상세 코드를 두 번 고치면 DB 에 묻기 전에 409', async () => {
        await expect(
          service.updateItems(9, 'EMP_TYPE', [update, update]),
        ).rejects.toThrow(
          new ConflictException(
            '한 요청에 같은 상세 코드가 두 번 있습니다: FULL',
          ),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('여러 행 중 하나라도 없으면 404 이고 아무것도 고치지 않는다', async () => {
        prisma.codeItem.findMany.mockResolvedValue([{ itemCode: 'FULL' }]);

        await expect(
          service.updateItems(9, 'EMP_TYPE', [
            update,
            { ...update, itemCode: 'NOPE' },
          ]),
        ).rejects.toThrow(
          new NotFoundException('상세 코드를 찾을 수 없습니다: NOPE'),
        );
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });

      it('플랫폼 원본에 없는 코드(BP전용 등)를 고치면 404', async () => {
        prisma.codeItem.findMany.mockResolvedValue([]);

        await expect(
          service.updateItems(9, 'EMP_TYPE', [update]),
        ).rejects.toThrow(
          new NotFoundException('상세 코드를 찾을 수 없습니다: FULL'),
        );
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });

      it('없는 그룹이면 404', async () => {
        prisma.codeGroup.findFirst.mockResolvedValue(null);

        await expect(
          service.updateItems(9, 'NOPE', [update]),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  // 등록 · 수정은 각자 트랜잭션 하나다 — 확인과 쓰기가 그 안에서만 일어난다.
  describe.each([
    {
      name: 'createGroups',
      run: (s: CodeGroupsService) =>
        s.createGroups(9, [
          {
            groupCode: 'BANK',
            groupName: '은행',
            manageOwnerCode: 'PLATFORM_PROVIDED',
            status: 'ACTIVE',
            sortOrder: 1,
          },
        ]),
    },
    {
      name: 'updateGroups',
      run: (s: CodeGroupsService) =>
        s.updateGroups(9, [
          {
            groupCode: 'EMP_TYPE',
            groupName: '고용 형태',
            status: 'ACTIVE',
            sortOrder: 1,
          },
        ]),
    },
    {
      name: 'createItems',
      run: (s: CodeGroupsService) =>
        s.createItems(9, 'EMP_TYPE', [
          { itemCode: 'INTERN', label: '인턴', status: 'ACTIVE', sortOrder: 1 },
        ]),
    },
    {
      name: 'updateItems',
      run: (s: CodeGroupsService) =>
        s.updateItems(9, 'EMP_TYPE', [
          { itemCode: 'FULL', label: '정규직', status: 'ACTIVE', sortOrder: 1 },
        ]),
    },
  ])('$name', ({ run }) => {
    it('트랜잭션 하나 안에서만 확인하고 쓴다', async () => {
      // 콜백을 부르지 않는 트랜잭션 — 밖에서 읽거나 쓰는 것이 있으면 아래에서 걸린다.
      prisma.$transaction.mockResolvedValue(undefined);

      await run(service);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // 두 번째 인자(시간 제한)는 경로마다 다르다 — 콜백 트랜잭션인지만 본다.
      const [[work]] = prisma.$transaction.mock.calls as [[unknown]];
      expect(work).toEqual(expect.any(Function));
      for (const call of [
        prisma.codeGroup.findMany,
        prisma.codeGroup.update,
        prisma.codeGroup.createManyAndReturn,
        prisma.codeItem.findMany,
        prisma.codeItem.update,
        prisma.codeItem.updateMany,
        prisma.codeItem.createMany,
        prisma.codeItem.createManyAndReturn,
      ])
        expect(call).not.toHaveBeenCalled();
    });
  });

  describe('deleteItems', () => {
    it('없는 그룹이면 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(
        service.deleteItems(9, 'NOPE', ['FULL']),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
    });

    it('한 요청에 같은 코드가 두 번이면 상세 코드 행을 읽기 전에 409', async () => {
      await expect(
        service.deleteItems(9, 'EMP_TYPE', ['FULL', 'FULL']),
      ).rejects.toThrow('한 요청에 같은 상세 코드가 두 번 있습니다: FULL');
      expect(prisma.codeItem.findMany).not.toHaveBeenCalled();
    });

    it('이 그룹의 지우지 않은 플랫폼 원본이 아니면 404 — 아무것도 지우지 않는다', async () => {
      prisma.codeItem.findMany.mockResolvedValue([{ itemCode: 'FULL' }]);

      await expect(
        service.deleteItems(9, 'EMP_TYPE', ['FULL', 'GHOST']),
      ).rejects.toThrow('상세 코드를 찾을 수 없습니다: GHOST');
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith({
        where: {
          groupCode: 'EMP_TYPE',
          bpCode: 'BP000000',
          isDeleted: false,
          manageOwnerCode: { not: 'BP_ONLY' },
          itemCode: { in: ['FULL', 'GHOST'] },
        },
        select: { itemCode: true },
      });
      expect(prisma.codeItem.updateMany).not.toHaveBeenCalled();
    });

    // BP 가 쓰는지와 관계없이 원본만 지운다 — 이미 BP 에 복사된 행은 그 BP 의 것이라 건드리지 않는다.
    it('플랫폼 원본만 논리 삭제한다 — BP 행은 건드리지 않는다', async () => {
      prisma.codeItem.findMany.mockResolvedValue([
        { itemCode: 'FULL' },
        { itemCode: 'PART' },
      ]);
      prisma.codeItem.updateMany.mockResolvedValue({ count: 2 });

      await service.deleteItems(9, 'EMP_TYPE', ['FULL', 'PART']);

      expect(prisma.codeItem.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.codeItem.updateMany).toHaveBeenCalledWith({
        where: {
          groupCode: 'EMP_TYPE',
          bpCode: 'BP000000',
          isDeleted: false,
          itemCode: { in: ['FULL', 'PART'] },
        },
        data: { isDeleted: true, updatedBy: 9 },
      });
    });

    it('확인 뒤 다른 관리자가 먼저 지웠으면(지운 행 수가 모자람) 409 — 일부만 지우지 않는다', async () => {
      prisma.codeItem.findMany.mockResolvedValue([
        { itemCode: 'FULL' },
        { itemCode: 'PART' },
      ]);
      prisma.codeItem.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.deleteItems(9, 'EMP_TYPE', ['FULL', 'PART']),
      ).rejects.toThrow(
        '다른 관리자가 먼저 지운 상세 코드가 있습니다 — 다시 불러온 뒤 삭제해 주세요',
      );
    });
  });

  describe('applyToBps', () => {
    const originals = [
      {
        groupCode: 'EMP_TYPE',
        itemCode: 'FULL',
        label: '정규직',
        status: 'ACTIVE',
        sortOrder: 1,
      },
      {
        groupCode: 'EMP_TYPE',
        itemCode: 'PART',
        label: '파트',
        status: 'INACTIVE',
        sortOrder: 2,
      },
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
