import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TodoExecutionMode, TodoStatus } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { adminNames } from '../common/admin-names';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
  type HqSharingSource,
} from '../admin-scope/hq-sharing';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday, parseDateOnly } from '../staff-members/kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from '../staff-members/staff-menu';
import { AssignableStaffResponseDto } from './dto/assignable-staff.dto';
import { CreatedTodoResponseDto, CreateTodoDto } from './dto/create-todo.dto';
import {
  ListTodosQueryDto,
  TodoPageQueryDto,
} from './dto/list-todos-query.dto';
import {
  TodoDetailDto,
  TodoItemDto,
  TodoItemListResponseDto,
  TodoListItemDto,
  TodoListResponseDto,
  TodoStaffDto,
} from './dto/todo.response.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { ACTIVE_STAFF, compareTodos, groupStatus } from './todo-rules';

const TODO_NOT_FOUND = 'TO-DO 를 찾을 수 없습니다';
const STORE_NOT_FOUND = '근무지 점포를 찾을 수 없습니다';

// date 컬럼은 UTC 자정, time 컬럼은 1970-01-01 의 그 시각으로 넘긴다(contracts.service 와 같다).
const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const toTime = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const hhmm = (time: Date | null) => time?.toISOString().slice(11, 16) ?? null;

type Actor = { changedBy: number } | { staffMemberId: number };

const STATUS_SELECT = {
  todoId: true,
  status: true,
  executionMode: true,
  performerStaffMemberId: true,
} as const;

/** 이름을 보일 직원 — 가림 판정에 쓸 계정의 본사 제공 동의까지 */
const STAFF_REF = {
  staffMemberId: true,
  name: true,
  ...HQ_SHARING_SELECT,
} as const;
const STAFF_NAME = { name: true, ...HQ_SHARING_SELECT } as const;

const PERFORMER = {
  performerStaffMember: { select: STAFF_REF },
} as const;

const LIST_SELECT = {
  todoId: true,
  assignmentGroupId: true,
  storeId: true,
  title: true,
  assigneeType: true,
  executionMode: true,
  dueDate: true,
  dueTime: true,
  isUrgent: true,
  status: true,
  createdAt: true,
  ...PERFORMER,
  todoAssignees: {
    select: { staffMemberId: true, staffMember: { select: STAFF_NAME } },
    orderBy: { staffMemberId: 'asc' },
  },
} as const satisfies Prisma.TodoSelect;

const ITEM_SELECT = {
  todoId: true,
  storeId: true,
  title: true,
  body: true,
  assigneeType: true,
  executionMode: true,
  dueDate: true,
  dueTime: true,
  isUrgent: true,
  status: true,
  completedAt: true,
  ...PERFORMER,
} as const satisfies Prisma.TodoSelect;

type ListRow = Prisma.TodoGetPayload<{ select: typeof LIST_SELECT }>;
type ItemRow = Prisma.TodoGetPayload<{ select: typeof ITEM_SELECT }>;

/**
 * 이 관리자에게 그 점포 직원의 개인 정보를 가리는가 — 직원 목록과 같은 hidesPersonalData(운영 정책 ATT-30). 본사
 * 역할(BM · BA)이 가맹 점포의, 본사 제공에 동의하지 않은 직원을 볼 때 참이다. 직원 근무 앱은 가리지 않는다(SHOW_ALL).
 */
type Hide = (storeId: number, isHqSharingConsented: boolean) => boolean;
const SHOW_ALL: Hide = () => false;

/** 가린 직원 — 직원 목록의 가린 줄처럼 ID 까지 비우고 isMasked 를 세운다. 그리는 방식은 화면이 정한다. */
const MASKED = {
  staffMemberId: null,
  staffMemberName: null,
  isMasked: true,
} as const;

const staffOf = (
  s: { staffMemberId: number; name: string } | null,
  masked: boolean,
): TodoStaffDto | null =>
  !s
    ? null
    : masked
      ? { ...MASKED }
      : {
          staffMemberId: s.staffMemberId,
          staffMemberName: s.name,
          isMasked: false,
        };

/**
 * TO-DO (#109). 관리자 웹 「TO-DO 리스트 관리」와 직원 상세, 직원 근무 앱의 근무 탭 · 홈이 쓴다.
 *
 * 관리자는 업무 범위(관리하는 점포) 안의 TO-DO 만 본다 — 밖의 것은 없는 것과 같다(404). TO-DO 는 점포 단위로 보되,
 * 본사 제공 동의 규칙(운영 정책 ATT-30 v143, 2026-10-19 재영)으로 보이는 범위를 좁힌다: 본사 역할이 가맹 점포를 볼 때
 * 동의하지 않은 직원은 직원 고르기 · 개인 배정 · 직원 필터에서 빠지고, 목록 · 상세의 직원 이름은 가린다(MASKED). 그런
 * 점포에는 근무지 전체 배정만 남는다 — 펼치기는 동의와 상관없다. 직원 상세의 TO-DO 영역은 그 직원을 다룰 수 있는지
 * (직원 상세와 같은 기준)를 본다.
 *
 * 목록은 읽은 뒤 정렬 · 묶음 · 페이지를 자른다(compareTodos). ponytail: 조건에 맞는 행을 모두 읽는다 — 점포의 TO-DO 가
 * 수만 건이 되면 SQL 의 COALESCE(assignment_group_id, todo_id) 묶음 + CASE 정렬로 옮긴다.
 */
@Injectable()
export class TodosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 등록. 배정 그룹을 펼쳐 행을 만들고, 행마다 등록 이력(→ 대기)을 남긴다. 배정 알림은 없다. */
  async create(
    adminAccountId: number,
    dto: CreateTodoDto,
    now: Date = new Date(),
  ): Promise<CreatedTodoResponseDto> {
    const executionMode = checkAssignment(dto);
    checkDueDate(dto.dueDate, now);
    const hidesStore = (await this.scopeOf(adminAccountId)).storeHides(
      dto.storeId,
    );
    if (hidesStore === null) throw new NotFoundException(STORE_NOT_FOUND);

    const individual = dto.assigneeType === 'INDIVIDUAL';
    const requested = dto.staffMemberIds ?? [];
    const fields = {
      storeId: dto.storeId,
      title: dto.title,
      body: dto.body ?? null,
      assigneeType: dto.assigneeType,
      executionMode,
      dueDate: toDate(dto.dueDate),
      dueTime: dto.dueTime ? toTime(dto.dueTime) : null,
      isUrgent: dto.isUrgent ?? false,
      createdBy: adminAccountId,
    };

    return this.prisma.$transaction(async (tx) => {
      // 퇴직 확정(행 FOR UPDATE · 조건부 UPDATE)과 겹치지 않게 그 점포 직원 행을 잠그고 읽는다. 잠금을 기다렸으면 바뀐
      // 행으로 다시 판정한다 — 확정된 퇴직자에게 배정이 새로 붙지 않는다(퇴직 정리가 이미 지나간 뒤라 풀리지 않는다).
      // ID 순으로 잠근다 — 근무스케줄 지난 주 복사가 여러 직원 행을 ID 순으로 잠그므로, 순서가 없으면 서로 엇갈려 교착(40P01)한다.
      await tx.$queryRaw`SELECT 1 FROM staff_members WHERE store_id = ${dto.storeId} ORDER BY staff_member_id FOR SHARE`;
      const staff = await tx.staffMember.findMany({
        where: {
          storeId: dto.storeId,
          ...ACTIVE_STAFF,
          // 개인 배정은 보이는 직원만 — 근무지 전체 펼치기는 동의와 상관없다(운영 정책 ATT-30)
          ...(individual && hidesStore ? HQ_SHARING_CONSENTED : {}),
          ...(individual ? { staffMemberId: { in: requested } } : {}),
        },
        select: { staffMemberId: true },
        orderBy: { staffMemberId: 'asc' },
      });
      if (individual && staff.length !== requested.length)
        throw new BadRequestException(
          '그 근무지에 체결 완료 근로계약이 있고 가입을 마친 재직 직원만 배정할 수 있습니다 — 퇴직했거나 계약이 체결되지 않았거나 가입 전이거나 다른 근무지 직원이 있습니다',
        );
      if (staff.length === 0)
        throw new BadRequestException(
          '근무지에 체결 완료 근로계약이 있고 가입을 마친 재직 직원이 없습니다',
        );

      // 한 명 수행은 공유 1행에 대상 전원, 그 밖은 직원마다 1행
      const ids = staff.map((m) => m.staffMemberId);
      const perRow =
        executionMode === 'ANY_ONE' ? [ids] : ids.map((id) => [id]);
      const rows = await tx.todo.createManyAndReturn({
        data: perRow.map(() => fields),
        select: { todoId: true },
      });
      // 행 내용이 모두 같아 어느 행을 누구에게 붙여도 된다. 그룹 ID 는 첫 행의 ID 다.
      const todoIds = rows.map((r) => r.todoId).sort((a, b) => a - b);
      const assignmentGroupId = todoIds.length > 1 ? todoIds[0] : null;
      if (assignmentGroupId !== null)
        await tx.todo.updateMany({
          where: { todoId: { in: todoIds } },
          data: { assignmentGroupId },
        });
      await tx.todoAssignee.createMany({
        data: todoIds.flatMap((todoId, i) =>
          perRow[i].map((staffMemberId) => ({ todoId, staffMemberId })),
        ),
      });
      await tx.todoStatusHistory.createMany({
        data: todoIds.map((todoId) => ({
          todoId,
          toStatus: 'PENDING' as const,
          changedBy: adminAccountId,
        })),
      });
      return { todoIds, assignmentGroupId };
    });
  }

  /**
   * 등록 화면의 직원 고르기. 배정할 수 있는 직원(ACTIVE_STAFF — 그 점포에 체결 완료 계약 · 가입 완료 · 퇴직 전)을 이름순으로 준다.
   * 근무지 판정은 등록과 같다(업무 범위 밖 404). 본사 역할이 가맹 점포를 보면 본사 제공에 동의한 직원만이다(운영 정책
   * ATT-30) — 개인 배정과 같은 범위다. 휴대전화번호는 끝 4자리만 낸다 — 화면이 이름 · 끝자리로 거른다.
   */
  async assignableStaff(
    adminAccountId: number,
    storeId: number,
  ): Promise<AssignableStaffResponseDto> {
    const hidesStore = (await this.scopeOf(adminAccountId)).storeHides(storeId);
    if (hidesStore === null) throw new NotFoundException(STORE_NOT_FOUND);
    const rows = await this.prisma.staffMember.findMany({
      where: {
        storeId,
        ...ACTIVE_STAFF,
        ...(hidesStore ? HQ_SHARING_CONSENTED : {}),
      },
      select: { staffMemberId: true, name: true, phone: true, jobTitle: true },
      orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
    });
    return {
      items: rows.map(({ phone, ...r }) => ({
        ...r,
        phoneLast4: phone.slice(-4),
      })),
    };
  }

  /** 관리자 웹 목록. 배정 그룹은 필터에 맞는 행끼리 한 줄로 묶는다. */
  async list(
    adminAccountId: number,
    query: ListTodosQueryDto,
  ): Promise<TodoListResponseDto> {
    const { storeIds, hide } = await this.scopeOf(adminAccountId);
    // 직원 필터 — 그 직원을 다룰 수 없으면(범위 밖 · 가려지는 직원) 직원 상세와 같은 404(운영 정책 ATT-30)
    if (
      query.staffMemberId &&
      !(await this.scope.canManageStaffMember(
        adminAccountId,
        query.staffMemberId,
      ))
    )
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    const ids = query.storeId
      ? storeIds.filter((id) => id === query.storeId)
      : storeIds;
    if (ids.length === 0) return { items: [], total: 0 };

    const where: Prisma.TodoWhereInput = {
      ...rowFilter(query),
      storeId: { in: ids },
    };
    if (query.assigneeType) where.assigneeType = query.assigneeType;
    if (query.isUrgent !== undefined) where.isUrgent = query.isUrgent;
    if (query.staffMemberId)
      where.todoAssignees = { some: { staffMemberId: query.staffMemberId } };

    const rows = await this.prisma.todo.findMany({
      where,
      select: LIST_SELECT,
    });
    const groups = new Map<number, ListRow[]>();
    for (const row of rows) {
      const key = row.assignmentGroupId ?? row.todoId;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const lines = [...groups.values()]
      .map((group) => toLine(group, hide))
      .sort(compareTodos);
    const page = lines.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    );
    const names = await this.storeNames(page);
    return {
      total: lines.length,
      items: page.map(({ dueDate, dueTime, ...line }) => ({
        ...line,
        dueDate: isoDate(dueDate),
        dueTime: hhmm(dueTime),
        storeName: names.get(line.storeId) ?? null,
      })),
    };
  }

  /** 상세 — 이 행의 배정 대상 · 상태 이력과, 그룹이면 직원별 상태. */
  async findOne(
    adminAccountId: number,
    todoId: number,
  ): Promise<TodoDetailDto> {
    const { where, hide } = await this.scopeOf(adminAccountId);
    const todo = await this.prisma.todo.findFirst({
      where: { todoId, ...where },
      select: {
        ...ITEM_SELECT,
        assignmentGroupId: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        todoAssignees: {
          select: {
            staffMemberId: true,
            isCompleted: true,
            completedAt: true,
            staffMember: { select: STAFF_NAME },
          },
          orderBy: { staffMemberId: 'asc' },
        },
        todoStatusHistories: {
          select: {
            fromStatus: true,
            toStatus: true,
            isUrgentChanged: true,
            changedBy: true,
            staffMemberId: true,
            unassignedStaffMemberId: true,
            changedAt: true,
            staffMember: { select: STAFF_NAME },
            unassignedStaffMember: { select: STAFF_NAME },
          },
          orderBy: [{ changedAt: 'desc' }, { todoStatusHistoryId: 'desc' }],
        },
      },
    });
    if (!todo) throw new NotFoundException(TODO_NOT_FOUND);

    const groupRows = todo.assignmentGroupId
      ? await this.prisma.todo.findMany({
          where: {
            assignmentGroupId: todo.assignmentGroupId,
            isDeleted: false,
          },
          select: {
            todoId: true,
            status: true,
            completedAt: true,
            todoAssignees: {
              select: {
                staffMemberId: true,
                staffMember: { select: STAFF_NAME },
              },
            },
          },
          orderBy: { todoId: 'asc' },
        })
      : [];
    const admins = await adminNames(this.prisma, [
      todo.createdBy,
      ...todo.todoStatusHistories.map((h) => h.changedBy),
    ]);
    const { todoAssignees, todoStatusHistories, ...rest } = todo;
    const hidden = (s: HqSharingSource | null) =>
      s !== null && hide(todo.storeId, hqSharingConsentedOf(s));
    return {
      ...(await this.toItems([rest], hide))[0],
      assignmentGroupId: todo.assignmentGroupId,
      createdBy: todo.createdBy,
      createdByName: admins.get(todo.createdBy) ?? null,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      assignees: todoAssignees.map((a) => ({
        ...staffOf({ ...a, name: a.staffMember.name }, hidden(a.staffMember))!,
        isCompleted: a.isCompleted,
        completedAt: a.completedAt,
      })),
      groupTodos: groupRows.map((r) => {
        const a = r.todoAssignees[0] ?? null;
        const masked = hidden(a?.staffMember ?? null);
        return {
          todoId: r.todoId,
          staffMemberId: masked ? null : (a?.staffMemberId ?? null),
          staffMemberName: masked ? null : (a?.staffMember.name ?? null),
          isMasked: masked,
          status: r.status,
          completedAt: r.completedAt,
        };
      }),
      histories: todoStatusHistories.map((h) => {
        const staffMasked = hidden(h.staffMember);
        const unassignedMasked = hidden(h.unassignedStaffMember);
        return {
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          isUrgentChanged: h.isUrgentChanged,
          changedBy: h.changedBy,
          changedByName: admins.get(h.changedBy) ?? null,
          staffMemberId: staffMasked ? null : h.staffMemberId,
          staffMemberName: staffMasked ? null : (h.staffMember?.name ?? null),
          isStaffMemberMasked: staffMasked,
          unassignedStaffMemberId: unassignedMasked
            ? null
            : h.unassignedStaffMemberId,
          unassignedStaffMemberName: unassignedMasked
            ? null
            : (h.unassignedStaffMember?.name ?? null),
          isUnassignedStaffMemberMasked: unassignedMasked,
          changedAt: h.changedAt,
        };
      }),
    };
  }

  /**
   * 제목 · 내용 · 수행 예정 일시 · 긴급 수정. 그룹이면 그룹의 (지우지 않은) 행 전체에 같은 값을 쓴다. 긴급이 바뀌면
   * 바뀐 행마다 상태는 그대로인 이력을 남긴다(is_urgent_changed). 수행 예정 일시가 바뀌면 수행 임박 알림이 새 일시로
   * 한 번 더 간다 — dedupe_key 에 일시가 들어 있다(T-3).
   */
  async update(
    adminAccountId: number,
    todoId: number,
    dto: UpdateTodoDto,
    now: Date = new Date(),
  ): Promise<TodoDetailDto> {
    const todo = await this.prisma.todo.findFirst({
      where: { todoId, ...(await this.scopeOf(adminAccountId)).where },
      select: { todoId: true, assignmentGroupId: true },
    });
    if (!todo) throw new NotFoundException(TODO_NOT_FOUND);
    if (dto.title === null || dto.dueDate === null || dto.isUrgent === null)
      throw new BadRequestException(
        '제목 · 수행 예정 날짜 · 긴급은 비울 수 없습니다',
      );
    if (dto.dueDate) checkDueDate(dto.dueDate, now);

    // 내용 · 시간의 null 은 비운다(비울 수 없는 칸의 null 은 위에서 400).
    const data: Prisma.TodoUpdateManyMutationInput = {};
    if (dto.title != null) data.title = dto.title;
    if (dto.body !== undefined) data.body = dto.body;
    if (dto.dueDate != null) data.dueDate = toDate(dto.dueDate);
    if (dto.dueTime !== undefined)
      data.dueTime = dto.dueTime === null ? null : toTime(dto.dueTime);
    if (dto.isUrgent != null) data.isUrgent = dto.isUrgent;

    const targets: Prisma.TodoWhereInput = {
      isDeleted: false,
      ...(todo.assignmentGroupId
        ? { assignmentGroupId: todo.assignmentGroupId }
        : { todoId }),
    };
    await this.prisma.$transaction(async (tx) => {
      if (dto.isUrgent != null) {
        const changed = await tx.todo.findMany({
          where: { ...targets, isUrgent: !dto.isUrgent },
          select: { todoId: true, status: true },
        });
        if (changed.length > 0)
          await tx.todoStatusHistory.createMany({
            data: changed.map((r) => ({
              todoId: r.todoId,
              fromStatus: r.status,
              toStatus: r.status,
              isUrgentChanged: true,
              changedBy: adminAccountId,
            })),
          });
      }
      await tx.todo.updateMany({ where: targets, data });
    });
    return this.findOne(adminAccountId, todoId);
  }

  /** 관리자가 상태를 바꾼다(T-1). 그룹이면 그 행만이다. 이력은 changed_by. */
  async changeStatus(
    adminAccountId: number,
    todoId: number,
    status: TodoStatus,
    now: Date = new Date(),
  ): Promise<TodoItemDto> {
    const { where, hide } = await this.scopeOf(adminAccountId);
    const todo = await this.prisma.todo.findFirst({
      where: { todoId, ...where },
      select: STATUS_SELECT,
    });
    if (!todo) throw new NotFoundException(TODO_NOT_FOUND);
    await this.transition(
      todo,
      status,
      { changedBy: adminAccountId },
      now,
      hide,
    );
    return this.item(todoId, hide);
  }

  /**
   * 삭제(is_deleted). 대기만 지운다. 그룹이면 그룹의 대기인 행만 지우고 진행 중 · 완료는 남긴다(T-2). 지울 행이
   * 없으면 409. 조건부 갱신이라 그사이 시작된 행은 지우지 않는다.
   */
  async remove(
    adminAccountId: number,
    todoId: number,
  ): Promise<{ deleted: number; remaining: number }> {
    const todo = await this.prisma.todo.findFirst({
      where: { todoId, ...(await this.scopeOf(adminAccountId)).where },
      select: { todoId: true, assignmentGroupId: true },
    });
    if (!todo) throw new NotFoundException(TODO_NOT_FOUND);
    const targets: Prisma.TodoWhereInput = todo.assignmentGroupId
      ? { isDeleted: false, assignmentGroupId: todo.assignmentGroupId }
      : { isDeleted: false, todoId };
    const { count } = await this.prisma.todo.updateMany({
      where: { ...targets, status: 'PENDING' },
      data: { isDeleted: true },
    });
    if (count === 0)
      throw new ConflictException('대기인 TO-DO 만 지울 수 있습니다');
    const remaining = todo.assignmentGroupId
      ? await this.prisma.todo.count({ where: targets })
      : 0;
    return { deleted: count, remaining };
  }

  /** 직원 상세의 TO-DO 영역(#118). 그 직원을 다룰 수 없으면(범위 밖 · 가려지는 직원) 직원 상세와 같은 404. */
  async listForStaffMember(
    adminAccountId: number,
    staffMemberId: number,
    query: TodoPageQueryDto,
  ): Promise<TodoItemListResponseDto> {
    if (!(await this.scope.canManageStaffMember(adminAccountId, staffMemberId)))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    // 그 직원은 보이지만, 한 명 수행의 수행자가 가려지는 다른 직원일 수 있다
    const { hide } = await this.scopeOf(adminAccountId);
    return this.items(
      { todoAssignees: { some: { staffMemberId } } },
      query,
      hide,
    );
  }

  /**
   * 직원 근무 앱 — 내 재직 직원 레코드(그 점포에 체결 완료 계약 · 가입 완료 · 퇴직 전, ACTIVE_STAFF)에 배정된 TO-DO(운영 정책 CTR-29). 근무지별로 묶는
   * 것은 앱이 storeId 로 한다.
   */
  async listMine(
    accountId: number,
    query: TodoPageQueryDto,
  ): Promise<TodoItemListResponseDto> {
    const mine = await this.myStaffIds(accountId);
    if (mine.length === 0) return { items: [], total: 0 };
    return this.items(
      { todoAssignees: { some: { staffMemberId: { in: mine } } } },
      query,
    );
  }

  /** 직원 근무 앱 — 내 TO-DO 상태 변경. 이력은 staff_member_id. */
  async changeMyStatus(
    accountId: number,
    todoId: number,
    status: TodoStatus,
    now: Date = new Date(),
  ): Promise<TodoItemDto> {
    const mine = await this.myStaffIds(accountId);
    const todo = await this.prisma.todo.findFirst({
      where: {
        todoId,
        isDeleted: false,
        todoAssignees: { some: { staffMemberId: { in: mine } } },
      },
      select: {
        ...STATUS_SELECT,
        todoAssignees: {
          where: { staffMemberId: { in: mine } },
          select: { staffMemberId: true },
        },
      },
    });
    if (!todo) throw new NotFoundException(TODO_NOT_FOUND);
    await this.transition(
      todo,
      status,
      { staffMemberId: todo.todoAssignees[0].staffMemberId },
      now,
    );
    return this.item(todoId);
  }

  /**
   * 상태 전환. 대기 · 진행 중 · 완료 사이를 오가고, 같은 상태면 아무것도 쓰지 않는다(두 번 누름).
   * 갱신은 읽은 상태를 조건으로 건다 — 완료는 늘 완료가 아닌 상태에서만 바뀌므로, 한 명 수행에서 둘이 함께 완료해도
   * 먼저 저장된 하나만 1건이 되고 늦은 쪽은 0건 → 409 TODO_ALREADY_DONE 이다. 한 명 수행은 본인이 완료한 것이
   * 아니면(다른 직원 · 관리자가 완료) 직원이 다시 열 수 없다(관리자는 된다). 그사이 지워졌으면 404.
   */
  private async transition(
    todo: {
      todoId: number;
      status: TodoStatus;
      executionMode: TodoExecutionMode;
      performerStaffMemberId: number | null;
    },
    to: TodoStatus,
    actor: Actor,
    now: Date,
    hide: Hide = SHOW_ALL,
  ): Promise<void> {
    const { todoId, status: from } = todo;
    const staffId = 'staffMemberId' in actor ? actor.staffMemberId : null;
    const shared = todo.executionMode === 'ANY_ONE';
    if (
      shared &&
      from === 'DONE' &&
      staffId !== null &&
      todo.performerStaffMemberId !== staffId
    )
      throw await this.conflict(this.prisma, todoId, 'DONE', hide);
    if (from === to) return;
    // 직원이 한 명 수행을 다시 열 때는 수행자도 조건에 건다 — 읽은 뒤 관리자가 열고 다른 직원이 다시 완료했으면 0건이다.
    const staffReopen = shared && staffId !== null && from === 'DONE';

    await this.prisma.$transaction(async (tx) => {
      const done = to === 'DONE';
      const { count } = await tx.todo.updateMany({
        where: {
          todoId,
          isDeleted: false,
          status: from,
          ...(staffReopen ? { performerStaffMemberId: staffId } : {}),
        },
        data: done
          ? {
              status: to,
              completedAt: now,
              performerStaffMemberId: shared ? staffId : null,
            }
          : { status: to, completedAt: null, performerStaffMemberId: null },
      });
      if (count === 0)
        throw await this.conflict(
          tx,
          todoId,
          to,
          hide,
          shared && staffId !== null,
        );

      // 배정의 완료 표시 — 각자 수행은 그 행의 직원, 한 명 수행은 완료한 직원만. 관리자가 완료한 공유 건은 비워 둔다.
      if (done && (!shared || staffId !== null))
        await tx.todoAssignee.updateMany({
          where: { todoId, ...(shared ? { staffMemberId: staffId! } : {}) },
          data: { isCompleted: true, completedAt: now },
        });
      if (from === 'DONE')
        await tx.todoAssignee.updateMany({
          where: { todoId },
          data: { isCompleted: false, completedAt: null },
        });
      await tx.todoStatusHistory.create({
        data: { todoId, fromStatus: from, toStatus: to, ...actor },
      });
    });
  }

  /**
   * 409 — 이미 완료됐으면 TODO_ALREADY_DONE(먼저 완료한 직원을 싣는다 — 관리자에게 가려지는 직원이면 가린다), 그 밖은
   * TODO_STATUS_CONFLICT. 직원이 한 명 수행을 바꾸려다 완료돼 있으면 되돌리기여도 TODO_ALREADY_DONE 이다. 그사이 지워졌으면 404.
   */
  private async conflict(
    db: Pick<Prisma.TransactionClient, 'todo'>,
    todoId: number,
    to: TodoStatus,
    hide: Hide,
    sharedByStaff = false,
  ): Promise<ConflictException | NotFoundException> {
    const now = await db.todo.findUnique({
      where: { todoId },
      select: { status: true, isDeleted: true, storeId: true, ...PERFORMER },
    });
    // 그사이 지워졌으면 없는 것과 같다
    if (!now || now.isDeleted) return new NotFoundException(TODO_NOT_FOUND);
    if (now.status === 'DONE' && (to === 'DONE' || sharedByStaff)) {
      const p = now.performerStaffMember;
      const performer = staffOf(
        p,
        p !== null && hide(now.storeId, hqSharingConsentedOf(p)),
      );
      return new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'TODO_ALREADY_DONE',
        message: performer?.staffMemberName
          ? `${performer.staffMemberName} 님이 먼저 완료했습니다`
          : '이미 완료된 TO-DO 입니다',
        performer,
      });
    }
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: 'TODO_STATUS_CONFLICT',
      message:
        '다른 곳에서 상태가 바뀌었습니다. 화면을 새로 고쳐 지금 상태를 확인해 주세요',
      status: now.status,
    });
  }

  private async myStaffIds(accountId: number): Promise<number[]> {
    const rows = await this.prisma.staffMember.findMany({
      where: { accountId, ...ACTIVE_STAFF },
      select: { staffMemberId: true },
    });
    return rows.map((r) => r.staffMemberId);
  }

  /**
   * 관리자의 업무 범위. `where` 는 지우지 않았고 범위 안 점포의 TO-DO 다 — 범위를 먼저 정하고 그 안에서 찾는다(없는 ID 와
   * 범위 밖이 같은 404). `hide` 는 직원 이름을 가릴지, `storeHides` 는 그 점포가 범위 안이면 동의하지 않은 직원을 가리는지
   * (밖이면 null)다. 사용 중인 관리자 계정이 아니면 403.
   */
  private async scopeOf(adminAccountId: number) {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const typeOf = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    const storeIds = [...typeOf.keys()];
    const hide: Hide = (storeId, isHqSharingConsented) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        typeOf.get(storeId),
        isHqSharingConsented,
      );
    return {
      storeIds,
      where: { isDeleted: false, storeId: { in: storeIds } },
      hide,
      storeHides: (storeId: number): boolean | null =>
        typeOf.has(storeId) ? hide(storeId, false) : null,
    };
  }

  private async items(
    where: Prisma.TodoWhereInput,
    query: TodoPageQueryDto,
    hide: Hide = SHOW_ALL,
  ): Promise<TodoItemListResponseDto> {
    const rows = await this.prisma.todo.findMany({
      where: {
        ...where,
        ...rowFilter(query),
        ...(query.storeId ? { storeId: query.storeId } : {}),
      },
      select: ITEM_SELECT,
    });
    rows.sort(compareTodos);
    const page = rows.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    );
    return { total: rows.length, items: await this.toItems(page, hide) };
  }

  private async item(
    todoId: number,
    hide: Hide = SHOW_ALL,
  ): Promise<TodoItemDto> {
    const row = await this.prisma.todo.findUnique({
      where: { todoId },
      select: ITEM_SELECT,
    });
    if (!row) throw new NotFoundException(TODO_NOT_FOUND);
    return (await this.toItems([row], hide))[0];
  }

  private async toItems(
    rows: ItemRow[],
    hide: Hide = SHOW_ALL,
  ): Promise<TodoItemDto[]> {
    const names = await this.storeNames(rows);
    return rows.map(({ performerStaffMember, dueDate, dueTime, ...r }) => ({
      ...r,
      storeName: names.get(r.storeId) ?? null,
      dueDate: isoDate(dueDate),
      dueTime: hhmm(dueTime),
      performer: staffOf(
        performerStaffMember,
        performerStaffMember !== null &&
          hide(r.storeId, hqSharingConsentedOf(performerStaffMember)),
      ),
    }));
  }

  /** stores 는 1팀 테이블이라 Prisma 관계가 없다 — 점포 id 로 따로 묻는다. */
  private async storeNames(
    rows: { storeId: number }[],
  ): Promise<Map<number, string>> {
    if (rows.length === 0) return new Map();
    const stores = await this.prisma.store.findMany({
      where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
      select: { storeId: true, name: true },
    });
    return new Map(stores.map((s) => [s.storeId, s.name]));
  }
}

/** 배정 대상 · 수행 방식 조합을 확인하고 저장할 수행 방식을 정한다. 개인은 각자 수행만이다. */
function checkAssignment(dto: CreateTodoDto): TodoExecutionMode {
  if (dto.assigneeType === 'INDIVIDUAL') {
    if (!dto.staffMemberIds?.length)
      throw new BadRequestException(
        '개인 배정은 직원을 한 명 이상 골라 주세요',
      );
    if (dto.executionMode === 'ANY_ONE')
      throw new BadRequestException('한 명 수행은 근무지 전체 배정에만 씁니다');
    return 'EACH';
  }
  if (dto.staffMemberIds)
    throw new BadRequestException('근무지 전체 배정은 직원을 고르지 않습니다');
  if (!dto.executionMode)
    throw new BadRequestException('근무지 전체 배정은 수행 방식을 골라 주세요');
  return dto.executionMode;
}

/** 수행 예정 날짜는 한국 날짜로 오늘 이후다. */
function checkDueDate(dueDate: string, now: Date): void {
  const date = parseDateOnly(dueDate);
  if (!date || date < kstToday(now))
    throw new BadRequestException('수행 예정 날짜는 오늘 이후여야 합니다');
}

/** 목록 공통 조건 — 지우지 않은 것, 상태, 수행 예정 기간 */
function rowFilter(query: TodoPageQueryDto): Prisma.TodoWhereInput {
  const where: Prisma.TodoWhereInput = { isDeleted: false };
  if (query.status?.length) where.status = { in: query.status };
  if (query.dueDateFrom || query.dueDateTo)
    where.dueDate = {
      ...(query.dueDateFrom ? { gte: toDate(query.dueDateFrom) } : {}),
      ...(query.dueDateTo ? { lte: toDate(query.dueDateTo) } : {}),
    };
  return where;
}

/** 그룹(또는 한 행)을 목록 한 줄로. 그 줄에 남은 행 가운데 첫 행의 ID 로 상세를 열고, 상태는 묶음 상태다. */
function toLine(
  rows: ListRow[],
  hide: Hide,
): Omit<TodoListItemDto, 'dueDate' | 'dueTime' | 'storeName'> & {
  dueDate: Date;
  dueTime: Date | null;
} {
  const sorted = [...rows].sort((a, b) => a.todoId - b.todoId);
  const first = sorted[0];
  return {
    todoId: first.todoId,
    assignmentGroupId: first.assignmentGroupId,
    storeId: first.storeId,
    title: first.title,
    assigneeType: first.assigneeType,
    executionMode: first.executionMode,
    dueDate: first.dueDate,
    dueTime: first.dueTime,
    isUrgent: first.isUrgent,
    status: groupStatus(sorted.map((r) => r.status)),
    todoCount: sorted.length,
    doneCount: sorted.filter((r) => r.status === 'DONE').length,
    assignees: sorted.flatMap((r) =>
      r.todoAssignees.map((a) =>
        staffOf(
          { staffMemberId: a.staffMemberId, name: a.staffMember.name },
          hide(r.storeId, hqSharingConsentedOf(a.staffMember)),
        )!,
      ),
    ),
    performer: staffOf(
      first.performerStaffMember,
      first.performerStaffMember !== null &&
        hide(first.storeId, hqSharingConsentedOf(first.performerStaffMember)),
    ),
    createdAt: first.createdAt,
  };
}
