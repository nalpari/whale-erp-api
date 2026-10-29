import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { READ_DENIED_MESSAGE } from '../auth/access-messages';
import {
  encryptPersonalData,
  staffTaxProfileAad,
} from '../common/personal-data-cipher';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberSummaryService } from './staff-member-summary.service';

const date = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
// 2026-10-21(수) 한국 시각 오전 — UTC 로는 전날 밤이라 한국 날짜로 정하는지 함께 본다
const NOW = new Date('2026-10-20T23:30:00Z');
const KEY = randomBytes(32);

describe('StaffMemberSummaryService', () => {
  let service: StaffMemberSummaryService;
  let scope: {
    canManageStaffMember: jest.Mock;
    canManageStaffAccount: jest.Mock;
  };
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    contract: { findFirst: jest.Mock; findMany: jest.Mock };
    alimtalkSendLog: { findMany: jest.Mock };
    staffTaxProfile: { findUnique: jest.Mock };
    codeItem: { findFirst: jest.Mock };
    workSchedule: { findMany: jest.Mock };
    store: { findMany: jest.Mock };
    payslip: { findMany: jest.Mock; count: jest.Mock };
    todo: { groupBy: jest.Mock };
    menu: { count: jest.Mock };
    todoStatusHistory: { findMany: jest.Mock };
  };

  // Logger spy 가 실패한 테스트에서도 다음 테스트로 새지 않게
  afterEach(() => jest.restoreAllMocks());

  beforeEach(async () => {
    scope = {
      canManageStaffMember: jest.fn().mockResolvedValue(true),
      canManageStaffAccount: jest.fn().mockResolvedValue(true),
    };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      contract: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      alimtalkSendLog: { findMany: jest.fn().mockResolvedValue([]) },
      staffTaxProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      codeItem: { findFirst: jest.fn().mockResolvedValue(null) },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      store: { findMany: jest.fn().mockResolvedValue([]) },
      payslip: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      todo: { groupBy: jest.fn().mockResolvedValue([]) },
      menu: { count: jest.fn().mockResolvedValue(1) },
      todoStatusHistory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        StaffMemberSummaryService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: PERSONAL_DATA_KEY, useValue: KEY },
      ],
    }).compile();
    service = module.get(StaffMemberSummaryService);
  });

  /** 목이 받은 첫 호출의 인자. 목 호출 기록은 any 라 린트(no-unsafe-*)를 지나도록 모양을 붙인다. */
  const nthArg = (mock: jest.Mock, n: number) =>
    (mock.mock.calls[n] as [Record<string, any>])[0];
  const firstArg = (mock: jest.Mock) => nthArg(mock, 0);

  describe('영역 권한 · 범위 — 다섯 영역 공통', () => {
    const areas = [
      ['contract', '/contracts', () => service.contract(9, 30, NOW)],
      [
        'workSchedules',
        '/work-schedules',
        () => service.workSchedules(9, 30, undefined, NOW),
      ],
      ['payslips', '/payslips', () => service.payslips(9, 30)],
      ['todos', '/todos', () => service.todos(9, 30)],
      ['sendLogs', '/contracts', () => service.sendLogs(9, 30)],
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
          prisma.contract.findMany,
          prisma.alimtalkSendLog.findMany,
          prisma.workSchedule.findMany,
          prisma.payslip.findMany,
          prisma.payslip.count,
          prisma.todo.groupBy,
          prisma.todoStatusHistory.findMany,
        ])
          expect(m).not.toHaveBeenCalled();
      },
    );

    it('판정할 사용 중 영역 메뉴가 없으면 403 은 그대로이고 오류 로그를 남긴다 — 메뉴 URL 변경 · 사용중지를 찾게', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      prisma.menu.count.mockResolvedValue(0);
      await expect(service.payslips(9, 30)).rejects.toThrow(
        new ForbiddenException(READ_DENIED_MESSAGE),
      );
      expect(firstArg(prisma.menu.count)).toEqual({
        where: { url: '/payslips', isDeleted: false, status: 'ACTIVE' },
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('/payslips'));
    });

    it('메뉴는 있고 권한만 없으면 로그를 남기지 않는다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      await expect(service.payslips(9, 30)).rejects.toThrow(ForbiddenException);
      expect(error).not.toHaveBeenCalled();
    });

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
        canViewPayrollAccount: true,
        payrollAccount: null,
      });
    });

    describe('payrollAccount — 신고 정보의 급여 계좌', () => {
      const sealed = (plain: string, staffId = 30, key = KEY) =>
        encryptPersonalData(
          key,
          plain,
          staffTaxProfileAad('payroll_account_number_encrypted', staffId),
        );
      const profile = (over: object = {}) => ({
        bankCode: 'B004',
        payrollAccountNumberEncrypted: sealed('12345678901234'),
        ...over,
      });

      it('신고 정보가 있으면 은행 이름 · 계좌번호 전체(가리지 않음) — 계약이 없어도', async () => {
        prisma.staffTaxProfile.findUnique.mockResolvedValue(profile());
        prisma.codeItem.findFirst.mockResolvedValue({ label: 'KB국민은행' });
        await expect(service.contract(9, 30, NOW)).resolves.toEqual({
          contract: null,
          canViewPayrollAccount: true,
          payrollAccount: {
            bankName: 'KB국민은행',
            accountNumber: '12345678901234',
          },
        });
        expect(firstArg(prisma.staffTaxProfile.findUnique)).toMatchObject({
          where: { staffMemberId: 30 },
        });
        expect(firstArg(prisma.codeItem.findFirst)).toMatchObject({
          where: { groupCode: 'BANK', itemCode: 'B004' },
          // 플랫폼 원본(BP000000, PLATFORM_BP_CODE)이 가장 작은 BP 코드라 먼저 온다는 가정
          orderBy: { bpCode: 'asc' },
        });
      });

      it('계약이 있어도 같이 온다', async () => {
        prisma.contract.findFirst.mockResolvedValue({
          contractId: 70,
          employmentType: 'FULL_TIME',
          contractMethod: 'ELECTRONIC',
          status: 'SIGNED',
          startDate: date('2026-03-01'),
          endDate: null,
          sentAt: null,
        });
        prisma.staffTaxProfile.findUnique.mockResolvedValue(profile());
        prisma.codeItem.findFirst.mockResolvedValue({ label: 'KB국민은행' });
        const res = await service.contract(9, 30, NOW);
        expect(res.contract?.contractId).toBe(70);
        expect(res.payrollAccount).toEqual({
          bankName: 'KB국민은행',
          accountNumber: '12345678901234',
        });
      });

      it('신고 정보가 없으면 null — 계약이 있어도', async () => {
        prisma.contract.findFirst.mockResolvedValue({
          contractId: 70,
          employmentType: null,
          contractMethod: null,
          status: null,
          startDate: null,
          endDate: null,
          sentAt: null,
        });
        const res = await service.contract(9, 30, NOW);
        expect(res.payrollAccount).toBeNull();
        expect(prisma.codeItem.findFirst).not.toHaveBeenCalled();
      });

      it('은행 코드가 공통코드에 없으면 코드를 그대로 준다', async () => {
        prisma.staffTaxProfile.findUnique.mockResolvedValue(
          profile({ bankCode: 'B999' }),
        );
        const res = await service.contract(9, 30, NOW);
        expect(res.payrollAccount).toEqual({
          bankName: 'B999',
          accountNumber: '12345678901234',
        });
      });

      it('풀 수 없으면(다른 직원 암호문) 500 — 계좌번호는 오류 · 로그에 남지 않는다', async () => {
        const errors = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation();
        prisma.staffTaxProfile.findUnique.mockResolvedValue(
          profile({
            payrollAccountNumberEncrypted: sealed('99998888777766', 31),
          }),
        );
        const err = await service.contract(9, 30, NOW).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect(
          JSON.stringify([(err as Error).message, errors.mock.calls]),
        ).not.toMatch(/99998888777766|12345678901234/);
      });

      it('키가 비어 있으면 503 — 신고 정보가 있을 때만', async () => {
        const keyless = await Test.createTestingModule({
          providers: [
            StaffMemberSummaryService,
            { provide: PrismaService, useValue: prisma },
            { provide: AdminScopeService, useValue: scope },
            { provide: PERSONAL_DATA_KEY, useValue: null },
          ],
        }).compile();
        const svc = keyless.get(StaffMemberSummaryService);
        await expect(svc.contract(9, 30, NOW)).resolves.toEqual({
          contract: null,
          canViewPayrollAccount: true,
          payrollAccount: null,
        });
        prisma.staffTaxProfile.findUnique.mockResolvedValue(profile());
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        await expect(svc.contract(9, 30, NOW)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });

      describe('canViewPayrollAccount — 본사 역할은 가맹 직원의 급여 계좌를 못 본다(동의와 상관없이)', () => {
        it('볼 수 없으면(본사 + 가맹 동의 직원) false · null — 신고 정보를 읽지도 풀지도 않는다(키가 없어도 503 이 아니다)', async () => {
          scope.canManageStaffAccount.mockResolvedValue(false);
          prisma.staffTaxProfile.findUnique.mockResolvedValue(profile());
          const keyless = await Test.createTestingModule({
            providers: [
              StaffMemberSummaryService,
              { provide: PrismaService, useValue: prisma },
              { provide: AdminScopeService, useValue: scope },
              { provide: PERSONAL_DATA_KEY, useValue: null },
            ],
          }).compile();
          const svc = keyless.get(StaffMemberSummaryService);
          const [withKey, withoutKey] = await Promise.all([
            service.contract(9, 30, NOW),
            svc.contract(9, 30, NOW),
          ]);
          for (const res of [withKey, withoutKey])
            expect(res).toEqual({
              contract: null,
              canViewPayrollAccount: false,
              payrollAccount: null,
            });
          expect(scope.canManageStaffAccount).toHaveBeenCalledWith(9, 30);
          expect(prisma.staffTaxProfile.findUnique).not.toHaveBeenCalled();
          expect(prisma.codeItem.findFirst).not.toHaveBeenCalled();
        });

        it('볼 수 없어도 계약 칸은 그대로 온다', async () => {
          scope.canManageStaffAccount.mockResolvedValue(false);
          prisma.contract.findFirst.mockResolvedValue(contract());
          const res = await service.contract(9, 30, NOW);
          expect(res.contract?.contractId).toBe(70);
          expect(res.canViewPayrollAccount).toBe(false);
          expect(res.payrollAccount).toBeNull();
        });

        it('볼 수 있고(본사 + 직영 · 가맹마스터 + 가맹) 신고 정보가 있으면 true · 계좌', async () => {
          scope.canManageStaffAccount.mockResolvedValue(true);
          prisma.staffTaxProfile.findUnique.mockResolvedValue(profile());
          prisma.codeItem.findFirst.mockResolvedValue({ label: 'KB국민은행' });
          const res = await service.contract(9, 30, NOW);
          expect(res.canViewPayrollAccount).toBe(true);
          expect(res.payrollAccount).toEqual({
            bankName: 'KB국민은행',
            accountNumber: '12345678901234',
          });
        });

        it('볼 수 있어도 신고 정보가 없으면 true · null', async () => {
          const res = await service.contract(9, 30, NOW);
          expect(res.canViewPayrollAccount).toBe(true);
          expect(res.payrollAccount).toBeNull();
        });

        it('기존 권한 · 범위 확인(403/404)이 먼저다 — 막히면 판정을 부르지 않는다', async () => {
          scope.canManageStaffMember.mockResolvedValue(false);
          await expect(service.contract(9, 30, NOW)).rejects.toBeInstanceOf(
            NotFoundException,
          );
          expect(scope.canManageStaffAccount).not.toHaveBeenCalled();
        });
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
        canViewPayrollAccount: true,
        payrollAccount: null,
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

  describe('sendLogs — 발송 이력 (WHALEERP-136)', () => {
    it('이 직원 레코드의 모든 계약이 보낸 가입 초대 · 소속 추가 확인 요청 알림톡을 오래된 순으로 읽어 최근 순으로 낸다', async () => {
      prisma.contract.findMany.mockResolvedValue([
        { contractId: 7 },
        { contractId: 8 },
      ]);
      prisma.alimtalkSendLog.findMany.mockResolvedValue([
        {
          alimtalkSendLogId: 1,
          templateCode: 'TALK_STAFF_INVITATION',
          relatedId: 7,
          result: 'SUCCEEDED',
          failureReason: null,
          sentAt: NOW,
        },
        {
          alimtalkSendLogId: 2,
          templateCode: 'TALK_STAFF_INVITATION',
          relatedId: 7,
          result: 'FAILED',
          failureReason: 'code=3018 http=200: x',
          sentAt: NOW,
        },
      ]);
      const { items } = await service.sendLogs(9, 30);
      expect(firstArg(prisma.contract.findMany).where).toEqual({
        staffMemberId: 30,
      });
      const query = firstArg(prisma.alimtalkSendLog.findMany);
      expect(query.where).toEqual({
        relatedType: 'contract',
        relatedId: { in: [7, 8] },
        templateCode: {
          in: ['TALK_STAFF_INVITATION', 'TALK_STAFF_AFFILIATION_REQUEST'],
        },
      });
      expect(query.orderBy).toEqual({ alimtalkSendLogId: 'asc' });
      expect(items.map((i) => [i.sendLogId, i.isResend, i.result])).toEqual([
        [2, true, 'FAILED'],
        [1, false, 'SUCCEEDED'],
      ]);
    });

    it('계약이 없으면 발송 이력을 읽지 않고 빈 목록', async () => {
      await expect(service.sendLogs(9, 30)).resolves.toEqual({ items: [] });
      expect(prisma.alimtalkSendLog.findMany).not.toHaveBeenCalled();
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
      payslipItems: [
        { isEntered: true, adjustedAmount: null, calculatedAmount: 2500000 },
      ],
      ...over,
    });

    it('명세서가 없으면 최근 빈 목록, 미발송 0', async () => {
      await expect(service.payslips(9, 30)).resolves.toEqual({
        recent: [],
        unsentCount: 0,
      });
    });

    it('최근 3건 — 상태와 관계없이(작성 중 포함) 급여 기간 시작일 최신순, 같으면 ID 내림차순', async () => {
      await service.payslips(9, 30);
      const arg = firstArg(prisma.payslip.findMany);
      expect(arg).toMatchObject({
        where: { staffMemberId: 30 },
        orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
        take: 3,
      });
      // 상태로 거르지 않는다 — 작성 중도 든다
      expect(arg.where).not.toHaveProperty('status');
      // 기본급 항목만 읽는다
      expect(arg).toMatchObject({
        select: {
          payslipItems: {
            where: { payslipItemMaster: { itemCode: 'BASE_PAY' } },
            select: {
              isEntered: true,
              adjustedAmount: true,
              calculatedAmount: true,
            },
          },
        },
      });
    });

    it('줄 모양 — 기본급은 BASE_PAY 계산값, 수당은 지급 총액 − 기본급, 작성 중도 그대로', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        payslip({
          payslipId: 81,
          periodStartDate: date('2026-10-01'),
          periodEndDate: date('2026-10-31'),
          status: 'DRAFTING',
        }),
      ]);
      const res = await service.payslips(9, 30);
      expect(res.recent).toEqual([
        {
          payslipId: 81,
          periodStartDate: '2026-10-01',
          periodEndDate: '2026-10-31',
          basePayAmount: 2500000,
          allowanceAmount: 526000,
          totalDeductionAmount: 241800,
          netPayAmount: 2784200,
          status: 'DRAFTING',
        },
      ]);
    });

    it('기본급은 관리자 수정값이 계산값보다 먼저다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        payslip({
          payslipItems: [
            {
              isEntered: true,
              adjustedAmount: 2600000,
              calculatedAmount: 2500000,
            },
          ],
        }),
      ]);
      const [row] = (await service.payslips(9, 30)).recent;
      expect(row).toMatchObject({
        basePayAmount: 2600000,
        allowanceAmount: 426000,
      });
    });

    it.each([
      ['항목이 없으면', []],
      [
        '계산값이 있어도 넣지 않은 줄(isEntered = false)이면',
        [{ isEntered: false, adjustedAmount: null, calculatedAmount: 2500000 }],
      ],
    ])('기본급 — %s null, 수당은 지급 총액 그대로', async (_, payslipItems) => {
      prisma.payslip.findMany.mockResolvedValue([payslip({ payslipItems })]);
      const [row] = (await service.payslips(9, 30)).recent;
      expect(row).toMatchObject({
        basePayAmount: null,
        allowanceAmount: 3026000,
      });
    });

    it('기본급 — 넣은 줄인데 수정값 · 계산값이 둘 다 비면 0(지급 총액과 같은 기준)', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        payslip({
          payslipItems: [
            { isEntered: true, adjustedAmount: null, calculatedAmount: null },
          ],
        }),
      ]);
      const [row] = (await service.payslips(9, 30)).recent;
      expect(row).toMatchObject({ basePayAmount: 0, allowanceAmount: 3026000 });
    });

    it('기본급 — 관리자가 0 으로 고쳤으면 계산값이 아니라 0, 수당은 지급 총액 그대로', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        payslip({
          payslipItems: [
            { isEntered: true, adjustedAmount: 0, calculatedAmount: 2500000 },
          ],
        }),
      ]);
      const [row] = (await service.payslips(9, 30)).recent;
      expect(row).toMatchObject({ basePayAmount: 0, allowanceAmount: 3026000 });
    });

    it('여러 건 — 받은 순서 · 건수 그대로, 줄마다 기본급 · 수당을 따로 낸다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        payslip({ payslipId: 83, grossPayAmount: 2000000, payslipItems: [] }),
        payslip({
          payslipId: 82,
          grossPayAmount: 3100000,
          payslipItems: [
            {
              isEntered: true,
              adjustedAmount: null,
              calculatedAmount: 2400000,
            },
          ],
        }),
        payslip({
          payslipId: 81,
          grossPayAmount: 3000000,
          payslipItems: [
            {
              isEntered: false,
              adjustedAmount: null,
              calculatedAmount: 2500000,
            },
          ],
        }),
      ]);
      const { recent } = await service.payslips(9, 30);
      expect(
        recent.map((r) => [r.payslipId, r.basePayAmount, r.allowanceAmount]),
      ).toEqual([
        [83, null, 2000000],
        [82, 2400000, 700000],
        [81, null, 3000000],
      ]);
    });

    it('응답에 조회용 칸(payslipItems · grossPayAmount)을 싣지 않는다', async () => {
      prisma.payslip.findMany.mockResolvedValue([payslip()]);
      const [row] = (await service.payslips(9, 30)).recent;
      expect(row).not.toHaveProperty('payslipItems');
      expect(row).not.toHaveProperty('grossPayAmount');
    });

    it('미발송 — 발송 완료가 아닌 명세서 모두(작성 중 · 검토 중 · 확정)', async () => {
      prisma.payslip.count.mockResolvedValue(2);
      const res = await service.payslips(9, 30);
      expect(firstArg(prisma.payslip.count)).toEqual({
        where: { staffMemberId: 30, status: { not: 'SENT' } },
      });
      expect(res.unsentCount).toBe(2);
    });
  });

  describe('todos — TO-DO 요약', () => {
    it('이 직원에게 배정된, 지우지 않은 TO-DO 의 전체 · 완료 · 미완료', async () => {
      prisma.todo.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { _all: 1 } },
        { status: 'IN_PROGRESS', _count: { _all: 1 } },
        { status: 'DONE', _count: { _all: 4 } },
      ]);
      const res = await service.todos(9, 30);
      // 한 쿼리로 센다 — 따로 세면 그 사이 바뀐 TO-DO 로 전체 − 완료가 어긋난다
      expect(prisma.todo.groupBy).toHaveBeenCalledTimes(1);
      expect(firstArg(prisma.todo.groupBy)).toMatchObject({
        by: ['status'],
        where: {
          isDeleted: false,
          todoAssignees: { some: { staffMemberId: 30 } },
        },
      });
      expect(res).toMatchObject({ total: 6, doneCount: 4, notDoneCount: 2 });
    });

    it('배정된 TO-DO 가 없으면 모두 0', async () => {
      await expect(service.todos(9, 30)).resolves.toMatchObject({
        total: 0,
        doneCount: 0,
        notDoneCount: 0,
        recentHistories: [],
      });
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
          // 다른 배정자의 퇴직 배정 해제(같은 상태 그대로인 행)는 이 직원의 이력이 아니다
          unassignedStaffMemberId: null,
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
  describe('경계 · 예외', () => {
    it('이번 주는 한국 날짜다 — 월요일 한국 0시~9시(UTC 로는 일요일)에도 그 월요일부터', async () => {
      const res = await service.workSchedules(
        9,
        30,
        undefined,
        new Date('2026-10-25T15:30:00Z'),
      );
      expect(res.weekStart).toBe('2026-10-26');
    });

    it('weekStart 가 있는 날짜가 아니면 400 — 이번 주로 바꿔 답하지 않는다', async () => {
      await expect(
        service.workSchedules(9, 30, '2026-02-30', NOW),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.workSchedule.findMany).not.toHaveBeenCalled();
    });

    it('근무스케줄의 점포를 못 찾으면 500 — 빈 점포 이름으로 내보내지 않는다(외래키가 깨진 것)', async () => {
      prisma.workSchedule.findMany.mockResolvedValue([
        {
          workScheduleId: 1,
          storeId: 5,
          startAt: new Date('2026-10-20T00:00:00Z'),
          endAt: new Date('2026-10-20T08:00:00Z'),
          breakMinutes: 60,
        },
      ]);
      await expect(
        service.workSchedules(9, 30, undefined, NOW),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('근무스케줄이 없으면 점포를 묻지 않는다', async () => {
      await service.workSchedules(9, 30, undefined, NOW);
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });

    it('이력 행에 관리자와 직원이 함께 있으면 관리자 · 긴급 표시 변경은 그대로 넘긴다', async () => {
      prisma.todoStatusHistory.findMany.mockResolvedValue([
        {
          todoStatusHistoryId: 600,
          todoId: 40,
          fromStatus: 'PENDING',
          toStatus: 'PENDING',
          isUrgentChanged: true,
          changedBy: 9,
          staffMemberId: 31,
          changedAt: new Date('2026-10-20T05:00:00Z'),
          todo: { title: '냉장고 정리' },
        },
      ]);
      const { recentHistories } = await service.todos(9, 30);
      expect(recentHistories[0]).toMatchObject({
        actor: 'ADMIN',
        isUrgentChanged: true,
      });
    });
  });
});
