import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { READ_DENIED_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberSummaryService } from './staff-member-summary.service';

const date = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
// 2026-10-21(수) 한국 시각 오전 — UTC 로는 전날 밤이라 한국 날짜로 정하는지 함께 본다
const NOW = new Date('2026-10-20T23:30:00Z');

describe('StaffMemberSummaryService', () => {
  let service: StaffMemberSummaryService;
  let scope: { canManageStaffMember: jest.Mock };
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    contract: { findFirst: jest.Mock };
    workSchedule: { findMany: jest.Mock };
    store: { findMany: jest.Mock };
    payslip: { findFirst: jest.Mock; count: jest.Mock };
    todo: { count: jest.Mock };
    todoStatusHistory: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    scope = { canManageStaffMember: jest.fn().mockResolvedValue(true) };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      contract: { findFirst: jest.fn().mockResolvedValue(null) },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      store: { findMany: jest.fn().mockResolvedValue([]) },
      payslip: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      todo: { count: jest.fn().mockResolvedValue(0) },
      todoStatusHistory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        StaffMemberSummaryService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(StaffMemberSummaryService);
  });

  /** 목이 받은 첫 호출의 인자. 목 호출 기록은 any 라 린트(no-unsafe-*)를 지나도록 모양을 붙인다. */
  const nthArg = (mock: jest.Mock, n: number) =>
    (mock.mock.calls[n] as [Record<string, any>])[0];
  const firstArg = (mock: jest.Mock) => nthArg(mock, 0);

  describe('영역 권한 · 범위 — 네 영역 공통', () => {
    const areas = [
      ['contract', '/contracts', () => service.contract(9, 30, NOW)],
      [
        'workSchedules',
        '/work-schedules',
        () => service.workSchedules(9, 30, undefined, NOW),
      ],
      ['payslips', '/payslips', () => service.payslips(9, 30, NOW)],
      ['todos', '/todos', () => service.todos(9, 30)],
    ] as const;

    it.each(areas)(
      '%s — 그 메뉴(%s)의 조회 권한이 없으면 「조회 권한이 없습니다.」 403',
      async (_, url, call) => {
        prisma.roleGroupMenu.count.mockResolvedValue(0);
        await expect(call()).rejects.toThrow(
          new ForbiddenException(READ_DENIED_MESSAGE),
        );
        expect(READ_DENIED_MESSAGE).toBe('조회 권한이 없습니다.');
        expect(firstArg(prisma.roleGroupMenu.count).where).toMatchObject({
          roleGroupId: 3,
          OR: [{ isReadable: true }],
          menu: { url },
        });
      },
    );

    it.each(areas)(
      '%s — 권한은 범위보다 먼저 본다 — 권한이 없으면 어떤 ID 든 같은 403',
      async (_, __, call) => {
        prisma.roleGroupMenu.count.mockResolvedValue(0);
        await expect(call()).rejects.toThrow(ForbiddenException);
        expect(scope.canManageStaffMember).not.toHaveBeenCalled();
      },
    );

    it.each(areas)(
      '%s — 없는 직원 · 범위 밖 · 가려지는 직원은 404 이고 영역을 읽지 않는다',
      async (_, __, call) => {
        scope.canManageStaffMember.mockResolvedValue(false);
        await expect(call()).rejects.toThrow(NotFoundException);
        expect(scope.canManageStaffMember).toHaveBeenCalledWith(9, 30);
        for (const m of [
          prisma.contract.findFirst,
          prisma.workSchedule.findMany,
          prisma.payslip.findFirst,
          prisma.payslip.count,
          prisma.todo.count,
          prisma.todoStatusHistory.findMany,
        ])
          expect(m).not.toHaveBeenCalled();
      },
    );

    it('사용 중인 관리자 계정이 아니면 권한이 없는 것과 같은 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.todos(9, 30)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('contract — 근로계약 요약', () => {
    const contract = (over: object = {}) => ({
      contractId: 70,
      employmentType: 'FULL_TIME',
      contractMethod: 'ELECTRONIC',
      status: 'SIGNED',
      startDate: date('2026-03-01'),
      endDate: date('2027-02-28'),
      sentAt: new Date('2026-02-24T01:00:00Z'),
      ...over,
    });

    it('계약이 없으면 null', async () => {
      await expect(service.contract(9, 30, NOW)).resolves.toEqual({
        contract: null,
      });
    });

    it('가장 최근 계약 — 직원 목록 · 상세와 같은 정렬(created_at NULL 뒤, ID)', async () => {
      await service.contract(9, 30, NOW);
      expect(firstArg(prisma.contract.findFirst)).toMatchObject({
        where: { staffMemberId: 30 },
        orderBy: [
          { createdAt: { sort: 'desc', nulls: 'last' } },
          { contractId: 'desc' },
        ],
      });
    });

    it('유형 · 기간 · 상태 · 최근 발송일 · 갱신 예정일(종료일 30일 전)', async () => {
      prisma.contract.findFirst.mockResolvedValue(contract());
      await expect(service.contract(9, 30, NOW)).resolves.toEqual({
        contract: {
          contractId: 70,
          employmentType: 'FULL_TIME',
          contractMethod: 'ELECTRONIC',
          status: 'SIGNED',
          startDate: '2026-03-01',
          endDate: '2027-02-28',
          lastSentAt: new Date('2026-02-24T01:00:00Z'),
          renewalDate: '2027-01-29',
        },
      });
    });

    it.each([
      ['무기한', { endDate: null }],
      ['체결 완료가 아님', { status: 'PENDING_SIGNATURE' }],
      [
        '종료일이 지난 체결 완료(종료 배치 전)',
        { endDate: date('2026-10-20') },
      ],
    ])('갱신 예정일 없음 — %s', async (_, over) => {
      prisma.contract.findFirst.mockResolvedValue(contract(over));
      const { contract: c } = await service.contract(9, 30, NOW);
      expect(c?.renewalDate).toBeNull();
    });

    it('종료일이 오늘(한국 날짜)이면 아직 갱신 예정이다', async () => {
      prisma.contract.findFirst.mockResolvedValue(
        contract({ endDate: date('2026-10-21') }),
      );
      const { contract: c } = await service.contract(9, 30, NOW);
      expect(c?.renewalDate).toBe('2026-09-21');
    });

    it('임시저장은 기간 · 발송일이 비어 있어도 그대로 null 로 낸다', async () => {
      prisma.contract.findFirst.mockResolvedValue(
        contract({
          status: 'DRAFT',
          employmentType: null,
          contractMethod: null,
          startDate: null,
          endDate: null,
          sentAt: null,
        }),
      );
      const { contract: c } = await service.contract(9, 30, NOW);
      expect(c).toMatchObject({
        startDate: null,
        endDate: null,
        lastSentAt: null,
        renewalDate: null,
      });
    });
  });

  describe('workSchedules — 한 주 근무스케줄', () => {
    const schedule = (id: number, start: string, end: string, brk = 60) => ({
      workScheduleId: id,
      storeId: 5,
      startAt: new Date(start),
      endAt: new Date(end),
      breakMinutes: brk,
    });

    it('주를 주지 않으면 한국 날짜로 이번 주(월~일)다', async () => {
      const res = await service.workSchedules(9, 30, undefined, NOW);
      expect(res).toMatchObject({
        weekStart: '2026-10-19',
        weekEnd: '2026-10-25',
        items: [],
        totalWorkMinutes: 0,
      });
      expect(firstArg(prisma.workSchedule.findMany)).toMatchObject({
        where: {
          staffMemberId: 30,
          isDeleted: false,
          // 근무일은 시작 일시의 한국 날짜 — 월요일 한국 0시부터 다음 월요일 한국 0시 전까지
          startAt: {
            gte: new Date('2026-10-18T15:00:00Z'),
            lt: new Date('2026-10-25T15:00:00Z'),
          },
        },
        orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
      });
    });

    it('주 중 아무 날짜나 주면 그 주의 월요일로 맞춘다 — 일요일은 앞 주', async () => {
      const res = await service.workSchedules(9, 30, '2026-10-25', NOW);
      expect(res.weekStart).toBe('2026-10-19');
      const mon = await service.workSchedules(9, 30, '2026-10-26', NOW);
      expect(mon.weekStart).toBe('2026-10-26');
    });

    it('근무일 · 한국 시각 · 휴게를 빼 근무시간과 주간 합계를 낸다 — 자정 넘김 포함', async () => {
      prisma.workSchedule.findMany.mockResolvedValue([
        // 10-20(화) 09:00~17:00, 휴게 60 → 420분
        schedule(1, '2026-10-20T00:00:00Z', '2026-10-20T08:00:00Z'),
        // 10-24(토) 22:00~다음 날 02:00, 휴게 0 → 240분
        schedule(2, '2026-10-24T13:00:00Z', '2026-10-24T17:00:00Z', 0),
      ]);
      prisma.store.findMany.mockResolvedValue([
        { storeId: 5, name: '모리커피 서초점' },
      ]);
      const res = await service.workSchedules(9, 30, undefined, NOW);
      expect(res.items).toEqual([
        {
          workScheduleId: 1,
          storeId: 5,
          storeName: '모리커피 서초점',
          workDate: '2026-10-20',
          startTime: '09:00',
          endTime: '17:00',
          breakMinutes: 60,
          workMinutes: 420,
        },
        {
          workScheduleId: 2,
          storeId: 5,
          storeName: '모리커피 서초점',
          workDate: '2026-10-24',
          startTime: '22:00',
          endTime: '02:00',
          breakMinutes: 0,
          workMinutes: 240,
        },
      ]);
      expect(res.totalWorkMinutes).toBe(660);
    });
  });

  describe('payslips — 급여명세서 요약', () => {
    const payslip = (over: object = {}) => ({
      payslipId: 80,
      periodStartDate: date('2026-09-01'),
      periodEndDate: date('2026-09-30'),
      status: 'SENT',
      grossPayAmount: 3026000,
      totalDeductionAmount: 241800,
      netPayAmount: 2784200,
      confirmedAt: new Date('2026-10-05T01:00:00Z'),
      ...over,
    });

    it('명세서가 없으면 둘 다 null, 미발송 0', async () => {
      await expect(service.payslips(9, 30, NOW)).resolves.toEqual({
        latestConfirmed: null,
        currentMonth: null,
        unsentCount: 0,
      });
    });

    it('최근 확정 — 확정 · 발송 완료 중 급여 기간이 가장 늦은 것', async () => {
      prisma.payslip.findFirst.mockResolvedValueOnce(payslip());
      const res = await service.payslips(9, 30, NOW);
      expect(nthArg(prisma.payslip.findFirst, 0)).toMatchObject({
        where: { staffMemberId: 30, status: { in: ['CONFIRMED', 'SENT'] } },
        orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
      });
      expect(res.latestConfirmed).toEqual({
        payslipId: 80,
        periodStartDate: '2026-09-01',
        periodEndDate: '2026-09-30',
        status: 'SENT',
        grossPayAmount: 3026000,
        totalDeductionAmount: 241800,
        netPayAmount: 2784200,
        confirmedAt: new Date('2026-10-05T01:00:00Z'),
      });
    });

    it('이번 달 — 급여 기간 시작일이 한국 날짜로 이번 달인 것(급여명세서 목록의 month 와 같다)', async () => {
      prisma.payslip.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          payslip({
            payslipId: 81,
            periodStartDate: date('2026-10-01'),
            periodEndDate: date('2026-10-31'),
            status: 'REVIEWING',
            confirmedAt: null,
          }),
        );
      const res = await service.payslips(9, 30, NOW);
      expect(nthArg(prisma.payslip.findFirst, 1)).toMatchObject({
        where: {
          staffMemberId: 30,
          periodStartDate: { gte: date('2026-10-01'), lt: date('2026-11-01') },
        },
      });
      expect(res.currentMonth).toMatchObject({
        payslipId: 81,
        status: 'REVIEWING',
      });
    });

    it('미발송 — 발송 완료가 아닌 명세서 모두(작성 중 · 검토 중 · 확정)', async () => {
      prisma.payslip.count.mockResolvedValue(2);
      const res = await service.payslips(9, 30, NOW);
      expect(firstArg(prisma.payslip.count)).toEqual({
        where: { staffMemberId: 30, status: { not: 'SENT' } },
      });
      expect(res.unsentCount).toBe(2);
    });
  });

  describe('todos — TO-DO 요약', () => {
    it('이 직원에게 배정된, 지우지 않은 TO-DO 의 전체 · 완료 · 미완료', async () => {
      prisma.todo.count.mockResolvedValueOnce(6).mockResolvedValueOnce(4);
      const res = await service.todos(9, 30);
      const assigned = {
        isDeleted: false,
        todoAssignees: { some: { staffMemberId: 30 } },
      };
      expect(nthArg(prisma.todo.count, 0)).toEqual({ where: assigned });
      expect(nthArg(prisma.todo.count, 1)).toEqual({
        where: { ...assigned, status: 'DONE' },
      });
      expect(res).toMatchObject({ total: 6, doneCount: 4, notDoneCount: 2 });
    });

    it('최근 처리 이력 5건 — 누가 바꿨는지는 관리자 · 직원 · 시스템만 낸다(다른 직원이 드러나지 않게)', async () => {
      prisma.todoStatusHistory.findMany.mockResolvedValue([
        {
          todoStatusHistoryId: 503,
          todoId: 40,
          fromStatus: 'IN_PROGRESS',
          toStatus: 'DONE',
          isUrgentChanged: false,
          changedBy: null,
          staffMemberId: 31,
          changedAt: new Date('2026-10-20T05:00:00Z'),
          todo: { title: '냉장고 정리' },
        },
        {
          todoStatusHistoryId: 502,
          todoId: 41,
          fromStatus: null,
          toStatus: 'PENDING',
          isUrgentChanged: false,
          changedBy: 9,
          staffMemberId: null,
          changedAt: new Date('2026-10-19T05:00:00Z'),
          todo: { title: 'POP 교체' },
        },
        {
          todoStatusHistoryId: 501,
          todoId: 42,
          fromStatus: 'PENDING',
          toStatus: 'PENDING',
          isUrgentChanged: false,
          changedBy: null,
          staffMemberId: null,
          changedAt: new Date('2026-10-18T05:00:00Z'),
          todo: { title: '시음 기록' },
        },
      ]);
      const res = await service.todos(9, 30);
      expect(firstArg(prisma.todoStatusHistory.findMany)).toMatchObject({
        where: {
          todo: {
            isDeleted: false,
            todoAssignees: { some: { staffMemberId: 30 } },
          },
        },
        orderBy: [{ changedAt: 'desc' }, { todoStatusHistoryId: 'desc' }],
        take: 5,
      });
      expect(res.recentHistories).toEqual([
        {
          todoStatusHistoryId: 503,
          todoId: 40,
          title: '냉장고 정리',
          fromStatus: 'IN_PROGRESS',
          toStatus: 'DONE',
          isUrgentChanged: false,
          actor: 'STAFF',
          changedAt: new Date('2026-10-20T05:00:00Z'),
        },
        expect.objectContaining({ todoStatusHistoryId: 502, actor: 'ADMIN' }),
        expect.objectContaining({ todoStatusHistoryId: 501, actor: 'SYSTEM' }),
      ]);
      expect(res.recentHistories[0]).not.toHaveProperty('staffMemberId');
    });
  });
});
