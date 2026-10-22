import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { READ_DENIED_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { ACTIVE_STAFF } from './todo-rules';
import { TodosService } from './todos.service';

const ADMIN = 9;
const NOW = new Date('2026-10-19T03:00:00Z'); // 한국 12:00
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

type Mock = jest.Mock;

/** 첫 호출의 첫 인자 — Prisma 호출 하나({ where, data })를 본다 */
type Call = { where?: unknown; data: Record<string, unknown>[] };
const firstArg = (mock: jest.Mock) => (mock.mock.calls[0] as [Call])[0];
/** 상태 변경 · 상세 뒤에 다시 읽는 한 행(ITEM_SELECT 모양) */
const itemRow = (patch: Record<string, unknown> = {}) => ({
  todoId: 7,
  storeId: 3,
  title: '마감 정산표 확인',
  body: null,
  assigneeType: 'ALL',
  executionMode: 'ANY_ONE',
  dueDate: d('2026-10-20'),
  dueTime: new Date('1970-01-01T18:00:00.000Z'),
  isUrgent: false,
  status: 'DONE',
  completedAt: NOW,
  performerStaffMember: null,
  ...patch,
});

const mockDb = () => ({
  todo: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    createManyAndReturn: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  },
  todoAssignee: {
    createMany: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  todoStatusHistory: { create: jest.fn(), createMany: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
  staffMember: { findMany: jest.fn().mockResolvedValue([]) },
  store: {
    findMany: jest.fn().mockResolvedValue([{ storeId: 3, name: '연남점' }]),
  },
  adminAccount: {
    findMany: jest.fn().mockResolvedValue([]),
    // 직원 상세 TO-DO 의 영역 권한(TO-DO 관리 조회) — 기본은 있음
    findFirst: jest.fn().mockResolvedValue({ roleGroupId: 1 }),
  },
  roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
  menu: { count: jest.fn().mockResolvedValue(1) },
});

describe('TodosService', () => {
  let service: TodosService;
  let db: ReturnType<typeof mockDb>;
  let scope: {
    getManageableStores: Mock;
    canManageStore: Mock;
    canManageStaffMember: Mock;
  };

  beforeEach(async () => {
    db = mockDb();
    const prisma = {
      ...db,
      $transaction: jest.fn((work: (tx: typeof db) => unknown) => work(db)),
    };
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 3, storeTypeCode: 'DIRECT' },
          { storeId: 4, storeTypeCode: 'FRANCHISE' },
        ],
      }),
      canManageStore: jest.fn().mockResolvedValue(true),
      canManageStaffMember: jest.fn().mockResolvedValue(true),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TodosService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(TodosService);
  });

  describe('create (배정 그룹 펼치기)', () => {
    const base: CreateTodoDto = {
      storeId: 3,
      title: '마감 정산표 확인',
      assigneeType: 'INDIVIDUAL',
      staffMemberIds: [11, 12],
      dueDate: '2026-10-20',
      dueTime: '18:00',
    };
    const created = (...ids: number[]) =>
      db.todo.createManyAndReturn.mockResolvedValue(
        ids.map((todoId) => ({ todoId })),
      );

    it('개인 여러 명 — 직원마다 1행, 같은 그룹(첫 행 ID), 직원마다 배정 1행, 등록 이력', async () => {
      db.staffMember.findMany.mockResolvedValue([
        { staffMemberId: 11 },
        { staffMemberId: 12 },
      ]);
      created(101, 100);

      await expect(service.create(ADMIN, base, NOW)).resolves.toEqual({
        todoIds: [100, 101],
        assignmentGroupId: 100,
      });
      expect(db.staffMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId: 3,
            ...ACTIVE_STAFF,
            staffMemberId: { in: [11, 12] },
          },
        }),
      );
      const rows = firstArg(db.todo.createManyAndReturn).data;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        storeId: 3,
        assigneeType: 'INDIVIDUAL',
        executionMode: 'EACH',
        dueDate: d('2026-10-20'),
        dueTime: new Date('1970-01-01T18:00:00.000Z'),
        isUrgent: false,
        createdBy: ADMIN,
      });
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { todoId: { in: [100, 101] } },
        data: { assignmentGroupId: 100 },
      });
      expect(db.todoAssignee.createMany).toHaveBeenCalledWith({
        data: [
          { todoId: 100, staffMemberId: 11 },
          { todoId: 101, staffMemberId: 12 },
        ],
      });
      expect(db.todoStatusHistory.createMany).toHaveBeenCalledWith({
        data: [100, 101].map((todoId) => ({
          todoId,
          toStatus: 'PENDING',
          changedBy: ADMIN,
        })),
      });
    });

    it('개인 한 명은 그룹이 없다', async () => {
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
      created(100);

      await expect(
        service.create(ADMIN, { ...base, staffMemberIds: [11] }, NOW),
      ).resolves.toEqual({ todoIds: [100], assignmentGroupId: null });
      expect(db.todo.updateMany).not.toHaveBeenCalled();
    });

    it('근무지 전체 · 각자 수행 — 등록 시점에 체결 완료 계약이 있는 재직자마다 1행(T-4), 그 밖은 뺀다', async () => {
      db.staffMember.findMany.mockResolvedValue([
        { staffMemberId: 11 },
        { staffMemberId: 12 },
        { staffMemberId: 13 },
      ]);
      created(100, 101, 102);
      const dto = {
        ...base,
        assigneeType: 'ALL' as const,
        executionMode: 'EACH' as const,
        staffMemberIds: undefined,
      };

      await expect(service.create(ADMIN, dto, NOW)).resolves.toEqual({
        todoIds: [100, 101, 102],
        assignmentGroupId: 100,
      });
      expect(firstArg(db.staffMember.findMany).where).toEqual({
        storeId: 3,
        ...ACTIVE_STAFF,
      });
      expect(firstArg(db.todoAssignee.createMany).data).toHaveLength(3);
    });

    it('근무지 전체 · 한 명 수행 — 공유 1행에 대상 전원, 그룹 없음', async () => {
      db.staffMember.findMany.mockResolvedValue([
        { staffMemberId: 11 },
        { staffMemberId: 12 },
      ]);
      created(100);
      const dto = {
        ...base,
        assigneeType: 'ALL' as const,
        executionMode: 'ANY_ONE' as const,
        staffMemberIds: undefined,
      };

      await expect(service.create(ADMIN, dto, NOW)).resolves.toEqual({
        todoIds: [100],
        assignmentGroupId: null,
      });
      expect(firstArg(db.todo.createManyAndReturn).data).toHaveLength(1);
      expect(db.todoAssignee.createMany).toHaveBeenCalledWith({
        data: [
          { todoId: 100, staffMemberId: 11 },
          { todoId: 100, staffMemberId: 12 },
        ],
      });
    });

    it('퇴직했거나 그 근무지에 체결 완료 근로계약이 없거나 다른 근무지 직원이면 배정할 수 없다(400)', async () => {
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);

      await expect(service.create(ADMIN, base, NOW)).rejects.toThrow(
        BadRequestException,
      );
      expect(db.todo.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('종이 계약으로 체결 완료지만 가입 전(계정 없음)인 직원은 배정할 수 없다(400) — 가입 완료를 함께 본다', async () => {
      // 11 은 가입 완료, 12 는 종이 계약 체결 완료 · 가입 전 → 조회 조건(joinStatus JOINED)에서 빠진다
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);

      await expect(service.create(ADMIN, base, NOW)).rejects.toThrow(
        BadRequestException,
      );
      expect(firstArg(db.staffMember.findMany).where).toMatchObject(
        ACTIVE_STAFF,
      );
      expect(db.todo.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('근무지에 재직 직원이 없으면 400', async () => {
      const dto = {
        ...base,
        assigneeType: 'ALL' as const,
        executionMode: 'EACH' as const,
        staffMemberIds: undefined,
      };
      await expect(service.create(ADMIN, dto, NOW)).rejects.toThrow(
        BadRequestException,
      );
    });

    it.each([
      ['개인인데 한 명 수행', { executionMode: 'ANY_ONE' as const }],
      ['개인인데 직원 없음', { staffMemberIds: undefined }],
      [
        '근무지 전체인데 직원을 고름',
        { assigneeType: 'ALL' as const, executionMode: 'EACH' as const },
      ],
      [
        '근무지 전체인데 수행 방식 없음',
        { assigneeType: 'ALL' as const, staffMemberIds: undefined },
      ],
      ['한국 날짜로 어제', { dueDate: '2026-10-18' }],
    ])('%s 이면 400', async (_, patch) => {
      await expect(
        service.create(ADMIN, { ...base, ...patch }, NOW),
      ).rejects.toThrow(BadRequestException);
      expect(db.todo.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('업무 범위 밖 근무지는 404', async () => {
      await expect(
        service.create(ADMIN, { ...base, storeId: 99 }, NOW),
      ).rejects.toThrow(NotFoundException);
      expect(scope.getManageableStores).toHaveBeenCalledWith(ADMIN);
      expect(db.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('퇴직 확정과 겹치지 않게 같은 트랜잭션에서 그 점포 직원 행을 FOR SHARE 로 잠그고 나서 배정 대상을 읽는다', async () => {
      db.staffMember.findMany.mockResolvedValue([
        { staffMemberId: 11 },
        { staffMemberId: 12 },
      ]);
      db.todo.createManyAndReturn.mockResolvedValue([
        { todoId: 100 },
        { todoId: 101 },
      ]);
      await service.create(ADMIN, base, NOW);

      const [sql, ...values] = db.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(sql.join('?')).toContain('FOR SHARE');
      expect(values).toEqual([3]);
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.staffMember.findMany.mock.invocationCallOrder[0],
      );
    });

    describe('본사 제공 동의(운영 정책 ATT-30) — 본사 역할이 가맹 점포에', () => {
      // 점포 4 는 가맹, 관리자는 BM
      it('개인 배정은 동의한 직원만 — 동의하지 않은 직원이 섞이면 400', async () => {
        db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
        await expect(
          service.create(ADMIN, { ...base, storeId: 4 }, NOW),
        ).rejects.toThrow(BadRequestException);
        expect(firstArg(db.staffMember.findMany).where).toEqual({
          storeId: 4,
          ...ACTIVE_STAFF,
          account: { is: { isHqSharingConsented: true } },
          staffMemberId: { in: [11, 12] },
        });
      });

      it('근무지 전체 펼치기는 동의와 상관없이 재직자 모두', async () => {
        db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
        db.todo.createManyAndReturn.mockResolvedValue([{ todoId: 100 }]);
        await service.create(
          ADMIN,
          {
            ...base,
            storeId: 4,
            assigneeType: 'ALL',
            executionMode: 'EACH',
            staffMemberIds: undefined,
          },
          NOW,
        );
        expect(firstArg(db.staffMember.findMany).where).toEqual({
          storeId: 4,
          ...ACTIVE_STAFF,
        });
      });

      it('직영 점포는 동의를 보지 않는다', async () => {
        db.staffMember.findMany.mockResolvedValue([
          { staffMemberId: 11 },
          { staffMemberId: 12 },
        ]);
        db.todo.createManyAndReturn.mockResolvedValue([
          { todoId: 100 },
          { todoId: 101 },
        ]);
        await service.create(ADMIN, base, NOW);
        expect(firstArg(db.staffMember.findMany).where).not.toHaveProperty(
          'account',
        );
      });
    });
  });

  describe('assignableStaff (등록의 직원 고르기)', () => {
    it('체결 완료 계약이 있고 퇴직하지 않은 직원만 이름순, 번호는 끝 4자리만', async () => {
      db.staffMember.findMany.mockResolvedValue([
        {
          staffMemberId: 12,
          name: '김직원',
          phone: '01012345678',
          jobTitle: '바리스타',
        },
      ]);

      await expect(service.assignableStaff(ADMIN, 3)).resolves.toEqual({
        items: [
          {
            staffMemberId: 12,
            name: '김직원',
            phoneLast4: '5678',
            jobTitle: '바리스타',
          },
        ],
      });
      expect(scope.getManageableStores).toHaveBeenCalledWith(ADMIN);
      expect(db.staffMember.findMany).toHaveBeenCalledWith({
        where: {
          storeId: 3,
          ...ACTIVE_STAFF,
        },
        select: {
          staffMemberId: true,
          name: true,
          phone: true,
          jobTitle: true,
        },
        orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
      });
    });

    it('업무 범위 밖 근무지는 404, 직원을 읽지 않는다', async () => {
      await expect(service.assignableStaff(ADMIN, 99)).rejects.toThrow(
        NotFoundException,
      );
      expect(db.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('본사 역할이 가맹 점포를 보면 본사 제공에 동의한 직원만(운영 정책 ATT-30)', async () => {
      await service.assignableStaff(ADMIN, 4);
      expect(firstArg(db.staffMember.findMany).where).toEqual({
        storeId: 4,
        ...ACTIVE_STAFF,
        account: { is: { isHqSharingConsented: true } },
      });
    });

    it('가맹 관리자(FM)는 자기 가맹 점포 직원을 동의와 상관없이 본다', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 4, storeTypeCode: 'FRANCHISE' }],
      });
      await service.assignableStaff(ADMIN, 4);
      expect(firstArg(db.staffMember.findMany).where).toEqual({
        storeId: 4,
        ...ACTIVE_STAFF,
      });
    });
  });

  describe('list (목록)', () => {
    const row = (
      todoId: number,
      patch: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      todoId,
      assignmentGroupId: null,
      storeId: 3,
      title: `t${todoId}`,
      assigneeType: 'INDIVIDUAL',
      executionMode: 'EACH',
      dueDate: d('2026-10-20'),
      dueTime: null,
      isUrgent: false,
      status: 'PENDING',
      createdAt: NOW,
      performerStaffMember: null,
      performerStaffMemberId: null,
      todoAssignees: [
        { staffMemberId: todoId + 10, staffMember: { name: `직원${todoId}` } },
      ],
      ...patch,
    });

    it('업무 범위 안 점포만, 그룹은 한 줄로 묶고, 미완료 긴급 → 미완료 → 완료 순', async () => {
      db.todo.findMany.mockResolvedValue([
        row(1, { status: 'DONE', isUrgent: true }),
        row(2, { assignmentGroupId: 2, dueDate: d('2026-10-21') }),
        row(3, {
          assignmentGroupId: 2,
          dueDate: d('2026-10-21'),
          status: 'DONE',
        }),
        row(4, { isUrgent: true, dueDate: d('2026-10-25') }),
        row(5),
      ]);

      const result = await service.list(ADMIN, {
        page: 1,
        pageSize: 20,
      });

      expect(firstArg(db.todo.findMany).where).toEqual({
        isDeleted: false,
        storeId: { in: [3, 4] },
      });
      expect(result.total).toBe(4);
      expect(result.items.map((i) => i.todoId)).toEqual([4, 5, 2, 1]);
      const group = result.items[2];
      expect(group).toMatchObject({
        todoId: 2,
        assignmentGroupId: 2,
        status: 'IN_PROGRESS',
        todoCount: 2,
        doneCount: 1,
        dueDate: '2026-10-21',
        storeName: '연남점',
        assignees: [
          { staffMemberId: 12, staffMemberName: '직원2' },
          { staffMemberId: 13, staffMemberName: '직원3' },
        ],
      });
    });

    it('필터 — 근무지 · 상태 · 담당 · 직원 · 기간 · 긴급, 범위 밖 근무지는 0건', async () => {
      await service.list(ADMIN, {
        page: 1,
        pageSize: 20,
        storeId: 4,
        status: ['PENDING', 'IN_PROGRESS'],
        assigneeType: 'ALL',
        staffMemberId: 12,
        dueDateFrom: '2026-10-01',
        dueDateTo: '2026-10-31',
        isUrgent: true,
      });
      expect(firstArg(db.todo.findMany).where).toEqual({
        isDeleted: false,
        storeId: { in: [4] },
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        dueDate: { gte: d('2026-10-01'), lte: d('2026-10-31') },
        assigneeType: 'ALL',
        isUrgent: true,
        todoAssignees: { some: { staffMemberId: 12 } },
      });

      db.todo.findMany.mockClear();
      await expect(
        service.list(ADMIN, { page: 1, pageSize: 20, storeId: 99 }),
      ).resolves.toEqual({ items: [], total: 0 });
      expect(db.todo.findMany).not.toHaveBeenCalled();
    });

    it('점포 범위 — 고른 점포(storeIds) · 점포 유형(storeTypes)은 업무 범위와 겹치는 점포만, 겹치지 않으면 0건', async () => {
      const whereOf = async (q: Record<string, unknown>) => {
        db.todo.findMany.mockClear();
        await service.list(ADMIN, { page: 1, pageSize: 20, ...q });
        return db.todo.findMany.mock.calls.length
          ? (firstArg(db.todo.findMany).where as { storeId: unknown }).storeId
          : null;
      };
      // 점포 유형으로 거를 때만 폐점을 빼러 점포를 묻는다 — 여기서는 모두 운영 중
      db.store.findMany.mockImplementation(
        ({ where }: { where: { storeId: { in: number[] } } }) =>
          Promise.resolve(where.storeId.in.map((storeId) => ({ storeId }))),
      );
      // 범위 밖 점포(99)는 빠진다
      expect(await whereOf({ storeIds: [4, 99] })).toEqual({ in: [4] });
      expect(await whereOf({ storeTypes: ['DIRECT'] })).toEqual({ in: [3] });
      expect(await whereOf({ storeTypes: ['DIRECT', 'FRANCHISE'] })).toEqual({
        in: [3, 4],
      });
      // 고른 점포와 점포 유형은 함께 건다(AND)
      expect(
        await whereOf({ storeIds: [3, 4], storeTypes: ['FRANCHISE'] }),
      ).toEqual({ in: [4] });
      // 겹치는 점포가 없으면 DB 를 묻지 않고 0건
      expect(await whereOf({ storeIds: [99] })).toBeNull();
      expect(
        await whereOf({ storeIds: [3], storeTypes: ['FRANCHISE'] }),
      ).toBeNull();

      // 점포 유형(상단 범위 직영 · 가맹)은 폐점 점포를 뺀다 — 고른 점포만이면 묻지 않는다(2026-10-22 재영)
      db.store.findMany.mockClear();
      db.store.findMany.mockResolvedValueOnce([]);
      expect(await whereOf({ storeTypes: ['DIRECT'] })).toBeNull();
      expect(firstArg(db.store.findMany)).toEqual({
        where: { storeId: { in: [3] }, storeStatusCode: { not: 'CLOSED' } },
        select: { storeId: true },
      });
      db.store.findMany.mockClear();
      await whereOf({ storeIds: [3] });
      expect(db.store.findMany).not.toHaveBeenCalled();
    });

    it('줄 단위로 페이지를 자른다', async () => {
      db.todo.findMany.mockResolvedValue([row(1), row(2), row(3)]);
      const result = await service.list(ADMIN, { page: 2, pageSize: 2 });
      expect(result).toMatchObject({ total: 3 });
      expect(result.items.map((i) => i.todoId)).toEqual([3]);
    });

    it('사용 중인 관리자 계정이 아니면 403', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      await expect(
        service.list(ADMIN, { page: 1, pageSize: 20 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('업무 범위', () => {
    it('범위 밖 · 지운 TO-DO 는 상세 · 수정 · 상태 변경 · 삭제 모두 404', async () => {
      db.todo.findFirst.mockResolvedValue(null);
      await expect(service.findOne(ADMIN, 7)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.update(ADMIN, 7, { title: 'x' }, NOW),
      ).rejects.toThrow(NotFoundException);
      await expect(service.changeStatus(ADMIN, 7, 'DONE')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove(ADMIN, 7)).rejects.toThrow(NotFoundException);
      for (const [args] of db.todo.findFirst.mock.calls as [Call][])
        expect(args.where).toEqual({
          todoId: 7,
          isDeleted: false,
          storeId: { in: [3, 4] },
        });
    });

    it('직원 상세의 TO-DO 는 TO-DO 관리 조회 권한이 있어야 한다 — 없으면 「조회 권한이 없습니다.」 403, 범위보다 먼저', async () => {
      db.roleGroupMenu.count.mockResolvedValue(0);
      await expect(
        service.listForStaffMember(ADMIN, 11, { page: 1, pageSize: 20 }),
      ).rejects.toThrow(new ForbiddenException(READ_DENIED_MESSAGE));
      expect(
        (db.roleGroupMenu.count.mock.calls[0] as [{ where: object }])[0].where,
      ).toMatchObject({ OR: [{ isReadable: true }], menu: { url: '/todos' } });
      expect(scope.canManageStaffMember).not.toHaveBeenCalled();
      expect(db.todo.findMany).not.toHaveBeenCalled();
    });

    it('직원 상세의 TO-DO 는 그 직원을 다룰 수 있어야 한다(404)', async () => {
      scope.canManageStaffMember.mockResolvedValue(false);
      await expect(
        service.listForStaffMember(ADMIN, 11, { page: 1, pageSize: 20 }),
      ).rejects.toThrow(NotFoundException);
      expect(db.todo.findMany).not.toHaveBeenCalled();
    });
  });

  describe('update (수정)', () => {
    it('그룹이면 그룹 전체를 고치고, 긴급이 바뀐 행마다 이력을 남긴다', async () => {
      db.todo.findFirst
        .mockResolvedValueOnce({ todoId: 7, assignmentGroupId: 5 })
        .mockResolvedValue({
          ...itemRow({ isUrgent: true, dueTime: null }),
          assignmentGroupId: 5,
          createdBy: ADMIN,
          createdAt: NOW,
          updatedAt: NOW,
          todoAssignees: [],
          todoStatusHistories: [],
        });
      db.todo.findMany.mockResolvedValueOnce([
        { todoId: 5, status: 'PENDING' },
        { todoId: 7, status: 'DONE' },
      ]);

      await expect(
        service.update(ADMIN, 7, { isUrgent: true, dueTime: null }, NOW),
      ).resolves.toMatchObject({
        todoId: 7,
        isUrgent: true,
        dueTime: null,
        assignmentGroupId: 5,
      });

      const targets = { isDeleted: false, assignmentGroupId: 5 };
      expect(db.todo.findMany).toHaveBeenCalledWith({
        where: { ...targets, isUrgent: false },
        select: { todoId: true, status: true },
      });
      expect(db.todoStatusHistory.createMany).toHaveBeenCalledWith({
        data: [
          {
            todoId: 5,
            fromStatus: 'PENDING',
            toStatus: 'PENDING',
            isUrgentChanged: true,
            changedBy: ADMIN,
          },
          {
            todoId: 7,
            fromStatus: 'DONE',
            toStatus: 'DONE',
            isUrgentChanged: true,
            changedBy: ADMIN,
          },
        ],
      });
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: targets,
        data: { isUrgent: true, dueTime: null },
      });
    });

    it('수행 예정 날짜를 지난 날로 바꾸면 400', async () => {
      db.todo.findFirst.mockResolvedValue({
        todoId: 7,
        assignmentGroupId: null,
      });
      await expect(
        service.update(ADMIN, 7, { dueDate: '2026-10-18' }, NOW),
      ).rejects.toThrow(BadRequestException);
      expect(db.todo.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('상태 변경', () => {
    const shared = {
      todoId: 7,
      status: 'IN_PROGRESS',
      executionMode: 'ANY_ONE',
      performerStaffMemberId: null,
    };

    beforeEach(() => {
      // 직원 근무 앱 — 계정 3 의 재직 직원 레코드 11
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
    });

    it('한 명 수행 — 먼저 완료한 직원이 수행자가 되고, 그 직원의 배정만 완료, 이력은 staff_member_id', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...shared,
        todoAssignees: [{ staffMemberId: 11 }],
      });

      db.todo.findUnique.mockResolvedValue(
        itemRow({
          performerStaffMember: { staffMemberId: 11, name: '나직원' },
        }),
      );

      await expect(
        service.changeMyStatus(3, 7, 'DONE', NOW),
      ).resolves.toMatchObject({
        todoId: 7,
        status: 'DONE',
        dueDate: '2026-10-20',
        dueTime: '18:00',
        storeName: '연남점',
        performer: { staffMemberId: 11, staffMemberName: '나직원' },
      });

      expect(firstArg(db.todo.findFirst).where).toEqual({
        todoId: 7,
        isDeleted: false,
        todoAssignees: { some: { staffMemberId: { in: [11] } } },
      });
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7, isDeleted: false, status: 'IN_PROGRESS' },
        data: {
          status: 'DONE',
          completedAt: NOW,
          performerStaffMemberId: 11,
        },
      });
      expect(db.todoAssignee.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7, staffMemberId: 11 },
        data: { isCompleted: true, completedAt: NOW },
      });
      expect(db.todoStatusHistory.create).toHaveBeenCalledWith({
        data: {
          todoId: 7,
          fromStatus: 'IN_PROGRESS',
          toStatus: 'DONE',
          staffMemberId: 11,
        },
      });
    });

    it('한 명 수행 경합 — 조건부 갱신이 0건이고 이미 완료면 409 TODO_ALREADY_DONE, 이력 없음', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...shared,
        todoAssignees: [{ staffMemberId: 11 }],
      });
      db.todo.updateMany.mockResolvedValue({ count: 0 });
      db.todo.findUnique.mockResolvedValue({
        status: 'DONE',
        performerStaffMember: { staffMemberId: 12, name: '김직원' },
      });

      const error = await service
        .changeMyStatus(3, 7, 'DONE', NOW)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'TODO_ALREADY_DONE',
        performer: { staffMemberId: 12, staffMemberName: '김직원' },
      });
      expect(db.todoStatusHistory.create).not.toHaveBeenCalled();
      expect(db.todoAssignee.updateMany).not.toHaveBeenCalled();
    });

    it('본인이 완료한 것이 아니면(다른 직원 완료) 직원은 한 명 수행을 다시 열 수도 또 완료할 수도 없다(409)', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...shared,
        status: 'DONE',
        performerStaffMemberId: 12,
        todoAssignees: [{ staffMemberId: 11 }],
      });
      db.todo.findUnique.mockResolvedValue({
        status: 'DONE',
        performerStaffMember: { staffMemberId: 12, name: '김직원' },
      });

      for (const to of ['DONE', 'PENDING'] as const)
        await expect(
          service.changeMyStatus(3, 7, to, NOW),
        ).rejects.toMatchObject({
          response: { code: 'TODO_ALREADY_DONE' },
        });
      expect(db.todo.updateMany).not.toHaveBeenCalled();
    });

    it('완료를 되돌리면 수행자 · 완료 시각 · 배정 완료를 비운다(관리자, 이력은 changed_by — T-1)', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...shared,
        status: 'DONE',
        performerStaffMemberId: 12,
      });

      db.todo.findUnique.mockResolvedValue(
        itemRow({ status: 'IN_PROGRESS', completedAt: null }),
      );

      await expect(
        service.changeStatus(ADMIN, 7, 'IN_PROGRESS', NOW),
      ).resolves.toMatchObject({
        todoId: 7,
        status: 'IN_PROGRESS',
        performer: null,
      });

      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7, isDeleted: false, status: 'DONE' },
        data: {
          status: 'IN_PROGRESS',
          completedAt: null,
          performerStaffMemberId: null,
        },
      });
      expect(db.todoAssignee.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7 },
        data: { isCompleted: false, completedAt: null },
      });
      expect(db.todoStatusHistory.create).toHaveBeenCalledWith({
        data: {
          todoId: 7,
          fromStatus: 'DONE',
          toStatus: 'IN_PROGRESS',
          changedBy: ADMIN,
        },
      });
    });

    it('같은 상태로 바꾸면 아무것도 쓰지 않는다(두 번 누름)', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...shared,
        executionMode: 'EACH',
        todoAssignees: [{ staffMemberId: 11 }],
      });
      db.todo.findUnique.mockResolvedValue(
        itemRow({ status: 'IN_PROGRESS', executionMode: 'EACH' }),
      );
      await expect(
        service.changeMyStatus(3, 7, 'IN_PROGRESS', NOW),
      ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
      expect(db.todo.updateMany).not.toHaveBeenCalled();
      expect(db.todoStatusHistory.create).not.toHaveBeenCalled();
    });

    it('내 직원 레코드에 배정되지 않았으면 404', async () => {
      await expect(service.changeMyStatus(3, 7, 'DONE', NOW)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('체결 완료 계약 · 가입 완료 · 퇴직 전인 내 직원 레코드가 없으면 내 TO-DO 는 비고, 상태 변경은 404 다(운영 정책 CTR-29)', async () => {
      db.staffMember.findMany.mockResolvedValue([]);
      await expect(
        service.listMine(3, { page: 1, pageSize: 20 }),
      ).resolves.toEqual({ items: [], total: 0 });
      expect(db.todo.findMany).not.toHaveBeenCalled();
      await expect(service.changeMyStatus(3, 7, 'DONE', NOW)).rejects.toThrow(
        NotFoundException,
      );
      expect(db.todo.findFirst.mock.calls[0]).toEqual([
        expect.objectContaining({
          where: expect.objectContaining({
            todoAssignees: { some: { staffMemberId: { in: [] } } },
          }) as unknown,
        }),
      ]);
      expect(db.todo.updateMany).not.toHaveBeenCalled();
    });

    it('내 직원 레코드는 그 점포에 체결 완료 계약이 있고 퇴직하지 않은 것만이다', async () => {
      await service.listMine(3, { page: 1, pageSize: 20 });
      expect(db.staffMember.findMany).toHaveBeenCalledWith({
        where: {
          accountId: 3,
          ...ACTIVE_STAFF,
        },
        select: { staffMemberId: true },
      });
    });
  });

  describe('remove (삭제)', () => {
    it('그룹이면 대기인 행만 지우고 지운 건수 · 남은 건수를 준다(T-2)', async () => {
      db.todo.findFirst.mockResolvedValue({ todoId: 7, assignmentGroupId: 5 });
      db.todo.updateMany.mockResolvedValue({ count: 2 });
      db.todo.count.mockResolvedValue(1);

      await expect(service.remove(ADMIN, 7)).resolves.toEqual({
        deleted: 2,
        remaining: 1,
      });
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { isDeleted: false, assignmentGroupId: 5, status: 'PENDING' },
        data: { isDeleted: true },
      });
      expect(db.todo.count).toHaveBeenCalledWith({
        where: { isDeleted: false, assignmentGroupId: 5 },
      });
    });

    it('대기가 아니면(지울 행이 없으면) 409', async () => {
      db.todo.findFirst.mockResolvedValue({
        todoId: 7,
        assignmentGroupId: null,
      });
      db.todo.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.remove(ADMIN, 7)).rejects.toThrow(ConflictException);
    });
  });
  describe('리뷰 보강', () => {
    beforeEach(() => {
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
    });
    const status = (patch: Record<string, unknown> = {}) => ({
      todoId: 7,
      status: 'IN_PROGRESS',
      executionMode: 'ANY_ONE',
      performerStaffMemberId: null,
      todoAssignees: [{ staffMemberId: 11 }],
      ...patch,
    });

    it('상세 — 그룹의 지우지 않은 행 · 직원 이름, 이력의 이름, 등록한 관리자 이름', async () => {
      db.todo.findFirst.mockResolvedValue({
        ...itemRow({ status: 'IN_PROGRESS', completedAt: null }),
        assignmentGroupId: 5,
        createdBy: ADMIN,
        createdAt: NOW,
        updatedAt: NOW,
        todoAssignees: [
          {
            staffMemberId: 11,
            isCompleted: false,
            completedAt: null,
            staffMember: { name: '나직원' },
          },
        ],
        todoStatusHistories: [
          {
            fromStatus: 'PENDING',
            toStatus: 'IN_PROGRESS',
            isUrgentChanged: false,
            changedBy: null,
            staffMemberId: 11,
            unassignedStaffMemberId: null,
            changedAt: NOW,
            staffMember: { name: '나직원' },
            unassignedStaffMember: null,
          },
          {
            fromStatus: null,
            toStatus: 'PENDING',
            isUrgentChanged: false,
            changedBy: ADMIN,
            staffMemberId: null,
            unassignedStaffMemberId: 12,
            changedAt: NOW,
            staffMember: null,
            unassignedStaffMember: { name: '퇴직자' },
          },
        ],
      });
      db.todo.findMany.mockResolvedValue([
        {
          todoId: 5,
          status: 'DONE',
          completedAt: NOW,
          todoAssignees: [
            { staffMemberId: 10, staffMember: { name: '다른직원' } },
          ],
        },
        {
          todoId: 7,
          status: 'IN_PROGRESS',
          completedAt: null,
          todoAssignees: [],
        },
      ]);
      db.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: ADMIN, name: '김관리' },
      ]);

      const detail = await service.findOne(ADMIN, 7);

      expect(firstArg(db.todo.findMany).where).toEqual({
        assignmentGroupId: 5,
        isDeleted: false,
      });
      expect(detail).toMatchObject({
        todoId: 7,
        storeName: '연남점',
        createdByName: '김관리',
        assignees: [{ staffMemberId: 11, staffMemberName: '나직원' }],
        groupTodos: [
          {
            todoId: 5,
            staffMemberId: 10,
            staffMemberName: '다른직원',
            status: 'DONE',
          },
          { todoId: 7, staffMemberId: null, staffMemberName: null },
        ],
        histories: [
          { staffMemberName: '나직원', changedByName: null },
          {
            changedByName: '김관리',
            unassignedStaffMemberId: 12,
            unassignedStaffMemberName: '퇴직자',
          },
        ],
      });
    });

    it('그사이 다른 상태로 바뀌었으면 409 TODO_STATUS_CONFLICT(지금 상태를 싣는다)', async () => {
      db.todo.findFirst.mockResolvedValue(status({ status: 'PENDING' }));
      db.todo.updateMany.mockResolvedValue({ count: 0 });
      db.todo.findUnique.mockResolvedValue({
        status: 'IN_PROGRESS',
        isDeleted: false,
        performerStaffMember: null,
      });
      await expect(
        service.changeMyStatus(3, 7, 'IN_PROGRESS', NOW),
      ).rejects.toMatchObject({
        response: { code: 'TODO_STATUS_CONFLICT', status: 'IN_PROGRESS' },
      });
    });

    it('그사이 지워졌으면 409 가 아니라 404', async () => {
      db.todo.findFirst.mockResolvedValue(status({ status: 'PENDING' }));
      db.todo.updateMany.mockResolvedValue({ count: 0 });
      db.todo.findUnique.mockResolvedValue({
        status: 'PENDING',
        isDeleted: true,
        performerStaffMember: null,
      });
      await expect(service.changeMyStatus(3, 7, 'DONE', NOW)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('관리자가 완료한 한 명 수행은 수행자가 없고 배정 완료도 바꾸지 않는다', async () => {
      db.todo.findFirst.mockResolvedValue(status());
      db.todo.findUnique.mockResolvedValue(itemRow());
      await service.changeStatus(ADMIN, 7, 'DONE', NOW);
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7, isDeleted: false, status: 'IN_PROGRESS' },
        data: {
          status: 'DONE',
          completedAt: NOW,
          performerStaffMemberId: null,
        },
      });
      expect(db.todoAssignee.updateMany).not.toHaveBeenCalled();
    });

    it('수행자 본인은 자기가 완료한 한 명 수행을 되돌릴 수 있다', async () => {
      db.todo.findFirst.mockResolvedValue(
        status({ status: 'DONE', performerStaffMemberId: 11 }),
      );
      db.todo.findUnique.mockResolvedValue(itemRow({ status: 'IN_PROGRESS' }));
      await service.changeMyStatus(3, 7, 'IN_PROGRESS', NOW);
      expect(db.todo.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            todoId: 7,
            isDeleted: false,
            status: 'DONE',
            performerStaffMemberId: 11,
          },
        }),
      );
    });

    it('관리자가 완료한 한 명 수행(수행자 없음)은 직원이 다시 열 수 없다(409)', async () => {
      db.todo.findFirst.mockResolvedValue(
        status({ status: 'DONE', performerStaffMemberId: null }),
      );
      db.todo.findUnique.mockResolvedValue({
        status: 'DONE',
        isDeleted: false,
        performerStaffMember: null,
      });
      await expect(
        service.changeMyStatus(3, 7, 'PENDING', NOW),
      ).rejects.toMatchObject({ response: { code: 'TODO_ALREADY_DONE' } });
      expect(db.todo.updateMany).not.toHaveBeenCalled();
    });

    it('각자 수행을 직원이 완료하면 그 행의 배정을 완료로', async () => {
      db.todo.findFirst.mockResolvedValue(status({ executionMode: 'EACH' }));
      db.todo.findUnique.mockResolvedValue(itemRow({ executionMode: 'EACH' }));
      await service.changeMyStatus(3, 7, 'DONE', NOW);
      expect(db.todo.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: 'DONE',
            completedAt: NOW,
            performerStaffMemberId: null,
          },
        }),
      );
      expect(db.todoAssignee.updateMany).toHaveBeenCalledWith({
        where: { todoId: 7 },
        data: { isCompleted: true, completedAt: NOW },
      });
    });

    it('등록 날짜는 한국 날짜 기준 — UTC 15:30(한국 다음 날 00:30)에는 한국 오늘이 되고 한국 어제는 400', async () => {
      const late = new Date('2026-10-19T15:30:00Z');
      db.staffMember.findMany.mockResolvedValue([{ staffMemberId: 11 }]);
      db.todo.createManyAndReturn.mockResolvedValue([{ todoId: 100 }]);
      const dto: CreateTodoDto = {
        storeId: 3,
        title: 't',
        assigneeType: 'INDIVIDUAL',
        staffMemberIds: [11],
        dueDate: '2026-10-20',
      };
      await expect(service.create(ADMIN, dto, late)).resolves.toMatchObject({
        todoIds: [100],
      });
      await expect(
        service.create(ADMIN, { ...dto, dueDate: '2026-10-19' }, late),
      ).rejects.toThrow(BadRequestException);
    });

    it('수정 — 그룹이 아니면 그 행만, 긴급이 그대로면 이력이 없다', async () => {
      db.todo.findFirst
        .mockResolvedValueOnce({ todoId: 7, assignmentGroupId: null })
        .mockResolvedValue({
          ...itemRow({ isUrgent: true }),
          assignmentGroupId: null,
          createdBy: ADMIN,
          createdAt: NOW,
          updatedAt: NOW,
          todoAssignees: [],
          todoStatusHistories: [],
        });
      db.todo.findMany.mockResolvedValueOnce([]); // 긴급이 바뀐 행 없음

      await expect(
        service.update(ADMIN, 7, { isUrgent: true, title: '새 제목' }, NOW),
      ).resolves.toMatchObject({ todoId: 7, groupTodos: [] });
      expect(db.todo.updateMany).toHaveBeenCalledWith({
        where: { isDeleted: false, todoId: 7 },
        data: { title: '새 제목', isUrgent: true },
      });
      expect(db.todoStatusHistory.createMany).not.toHaveBeenCalled();
    });

    it.each([['title'], ['dueDate'], ['isUrgent']])(
      '수정에서 %s 에 null 이 오면 400(비울 수 없는 칸)',
      async (field) => {
        db.todo.findFirst.mockResolvedValue({
          todoId: 7,
          assignmentGroupId: null,
        });
        await expect(
          service.update(ADMIN, 7, { [field]: null }, NOW),
        ).rejects.toThrow(BadRequestException);
        expect(db.todo.updateMany).not.toHaveBeenCalled();
      },
    );

    describe('본사 제공 동의 가림(운영 정책 ATT-30)', () => {
      const listRow = (storeId: number, consented: boolean) => ({
        todoId: storeId * 10,
        assignmentGroupId: null,
        storeId,
        title: 't',
        assigneeType: 'ALL',
        executionMode: 'ANY_ONE',
        dueDate: d('2026-10-20'),
        dueTime: null,
        isUrgent: false,
        status: 'DONE',
        createdAt: NOW,
        performerStaffMember: {
          staffMemberId: 21,
          name: '수행자',
          account: { isHqSharingConsented: consented },
        },
        todoAssignees: [
          {
            staffMemberId: 21,
            staffMember: {
              name: '수행자',
              account: { isHqSharingConsented: consented },
            },
          },
        ],
      });
      const MASKED = {
        staffMemberId: null,
        staffMemberName: null,
        isMasked: true,
      };

      it('목록 — 가맹 점포의 동의하지 않은 직원은 ID · 이름을 비우고 isMasked, 동의했거나 직영이면 그대로', async () => {
        db.todo.findMany.mockResolvedValue([
          listRow(4, false),
          listRow(3, false),
          { ...listRow(4, true), todoId: 41 },
        ]);
        const { items } = await service.list(ADMIN, { page: 1, pageSize: 20 });
        const byId = new Map(items.map((i) => [i.todoId, i]));
        expect(byId.get(40)).toMatchObject({
          assignees: [MASKED],
          performer: MASKED,
        });
        const shown = {
          staffMemberId: 21,
          staffMemberName: '수행자',
          isMasked: false,
        };
        expect(byId.get(30)).toMatchObject({
          assignees: [shown],
          performer: shown,
        });
        expect(byId.get(41)).toMatchObject({ performer: shown });
      });

      it('목록 — 가맹 점포의 가입 전(계정 없음) 직원도 가린다', async () => {
        const row = listRow(4, true);
        db.todo.findMany.mockResolvedValue([
          {
            ...row,
            performerStaffMember: {
              ...row.performerStaffMember,
              account: null,
            },
            todoAssignees: [
              {
                staffMemberId: 21,
                staffMember: { name: '수행자', account: null },
              },
            ],
          },
        ]);
        const { items } = await service.list(ADMIN, { page: 1, pageSize: 20 });
        expect(items[0]).toMatchObject({
          assignees: [MASKED],
          performer: MASKED,
        });
      });

      it('목록의 직원 필터 — 그 직원을 다룰 수 없으면(가려지는 직원 포함) 직원 상세와 같은 404', async () => {
        scope.canManageStaffMember.mockResolvedValue(false);
        await expect(
          service.list(ADMIN, { page: 1, pageSize: 20, staffMemberId: 21 }),
        ).rejects.toThrow(NotFoundException);
        expect(scope.canManageStaffMember).toHaveBeenCalledWith(ADMIN, 21);
        expect(db.todo.findMany).not.toHaveBeenCalled();
      });

      it('상세 — 배정 대상 · 그룹 행 · 이력의 직원 · 수행자를 가린다', async () => {
        const hidden = {
          name: '가맹직원',
          account: { isHqSharingConsented: false },
        };
        db.todo.findFirst.mockResolvedValue({
          ...itemRow({
            storeId: 4,
            performerStaffMember: { staffMemberId: 21, ...hidden },
          }),
          assignmentGroupId: 5,
          createdBy: ADMIN,
          createdAt: NOW,
          updatedAt: NOW,
          todoAssignees: [
            {
              staffMemberId: 21,
              isCompleted: true,
              completedAt: NOW,
              staffMember: hidden,
            },
          ],
          todoStatusHistories: [
            {
              fromStatus: 'IN_PROGRESS',
              toStatus: 'DONE',
              isUrgentChanged: false,
              changedBy: null,
              staffMemberId: 21,
              unassignedStaffMemberId: 22,
              changedAt: NOW,
              staffMember: hidden,
              unassignedStaffMember: hidden,
            },
          ],
        });
        db.todo.findMany.mockResolvedValue([
          {
            todoId: 7,
            status: 'DONE',
            completedAt: NOW,
            todoAssignees: [{ staffMemberId: 21, staffMember: hidden }],
          },
        ]);

        const detail = await service.findOne(ADMIN, 7);

        expect(detail.performer).toEqual(MASKED);
        expect(detail.assignees).toEqual([
          { ...MASKED, isCompleted: true, completedAt: NOW },
        ]);
        expect(detail.groupTodos).toEqual([
          { todoId: 7, ...MASKED, status: 'DONE', completedAt: NOW },
        ]);
        expect(detail.histories[0]).toMatchObject({
          staffMemberId: null,
          staffMemberName: null,
          isStaffMemberMasked: true,
          unassignedStaffMemberId: null,
          unassignedStaffMemberName: null,
          isUnassignedStaffMemberMasked: true,
        });
      });

      it('관리자 상태 변경의 응답 수행자도 가린다', async () => {
        db.todo.findFirst.mockResolvedValue(status({ status: 'PENDING' }));
        db.todo.findUnique.mockResolvedValue(
          itemRow({
            storeId: 4,
            performerStaffMember: {
              staffMemberId: 21,
              name: '가맹직원',
              account: { isHqSharingConsented: false },
            },
          }),
        );
        await expect(
          service.changeStatus(ADMIN, 7, 'IN_PROGRESS', NOW),
        ).resolves.toMatchObject({ performer: MASKED });
      });

      it('직원 근무 앱은 가리지 않는다(동료 이름 공개, WORK-3)', async () => {
        db.todo.findMany.mockResolvedValue([
          itemRow({
            storeId: 4,
            performerStaffMember: {
              staffMemberId: 21,
              name: '가맹직원',
              account: { isHqSharingConsented: false },
            },
          }),
        ]);
        const { items } = await service.listMine(3, { page: 1, pageSize: 20 });
        expect(items[0].performer).toEqual({
          staffMemberId: 21,
          staffMemberName: '가맹직원',
          isMasked: false,
        });
      });
    });

    it('한 명 수행 되돌리기는 수행자가 나일 때만 갱신한다 — 그사이 다른 직원이 다시 완료했으면 409 TODO_ALREADY_DONE', async () => {
      db.todo.findFirst.mockResolvedValue(
        status({ status: 'DONE', performerStaffMemberId: 11 }),
      );
      db.todo.updateMany.mockResolvedValue({ count: 0 });
      db.todo.findUnique.mockResolvedValue({
        status: 'DONE',
        isDeleted: false,
        performerStaffMember: { staffMemberId: 12, name: '김직원' },
      });

      await expect(
        service.changeMyStatus(3, 7, 'PENDING', NOW),
      ).rejects.toMatchObject({ response: { code: 'TODO_ALREADY_DONE' } });
      expect(firstArg(db.todo.updateMany).where).toEqual({
        todoId: 7,
        isDeleted: false,
        status: 'DONE',
        performerStaffMemberId: 11,
      });
    });

    it('내 TO-DO 목록 조건 — 내 레코드에 배정 · 지우지 않은 것', async () => {
      await service.listMine(3, { page: 1, pageSize: 20 });
      expect(firstArg(db.todo.findMany).where).toEqual({
        todoAssignees: { some: { staffMemberId: { in: [11] } } },
        isDeleted: false,
      });
    });

    it('직원 상세의 TO-DO 조건 — 그 직원에 배정 · 지우지 않은 것', async () => {
      await service.listForStaffMember(ADMIN, 11, { page: 1, pageSize: 20 });
      expect(scope.canManageStaffMember).toHaveBeenCalledWith(ADMIN, 11);
      expect(firstArg(db.todo.findMany).where).toEqual({
        todoAssignees: { some: { staffMemberId: 11 } },
        isDeleted: false,
      });
    });
  });
});
