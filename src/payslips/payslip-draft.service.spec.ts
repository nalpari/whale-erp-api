import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { attendanceReviewReasons } from './payslip-attendance-reasons';
import { calculatePayslip } from './payslip-calculation';
import { PayslipDraftService } from './payslip-draft.service';

// 금액 계산(WHALEERP-227)은 pay-calculation.spec 이 본다. 여기서는 계산값이 항목 · 합계로 옮겨지는지만 본다 — 기본은 계산할 수 없음.
jest.mock('./payslip-calculation', () => ({
  ...jest.requireActual<object>('./payslip-calculation'),
  calculatePayslip: jest.fn(),
}));
const calculate = calculatePayslip as jest.Mock;
// 출퇴근 검토 대기 사유(WHALEERP-229)는 payslip-attendance-reasons.spec 이 본다. 여기서는 사유가 명세서에 붙는 순서만 본다.
jest.mock('./payslip-attendance-reasons', () => ({
  ...jest.requireActual<object>('./payslip-attendance-reasons'),
  attendanceReviewReasons: jest.fn(),
}));
const attendanceReasons = attendanceReviewReasons as jest.Mock;
const NOTHING = {
  basePay: null,
  weeklyHolidayPay: null,
  overtimePay: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
  weeklyHolidayWeeks: 0,
};

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const staff = (over: object = {}) => ({
  staffMemberId: 30,
  storeId: 5,
  name: '서지안',
  employmentType: 'FULL_TIME',
  contracts: [{ contractId: 7, employmentType: 'PART_TIME' }],
  payslips: [],
  ...over,
});

const MASTERS = [
  {
    payslipItemMasterId: 1,
    itemCode: 'BASE_PAY',
    name: '기본급',
    category: 'EARNING',
    isTaxFree: false,
  },
  {
    payslipItemMasterId: 9,
    itemCode: 'MEAL_ALLOWANCE',
    name: '식대',
    category: 'EARNING',
    isTaxFree: true,
  },
  {
    payslipItemMasterId: 12,
    itemCode: 'NATIONAL_PENSION',
    name: '국민연금',
    category: 'BASIC',
    isTaxFree: false,
  },
  {
    payslipItemMasterId: 28,
    itemCode: 'BUSINESS_INCOME_TAX',
    name: '사업소득세(3%)',
    category: 'WITHHOLDING',
    isTaxFree: false,
  },
];

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('PayslipDraftService', () => {
  let service: PayslipDraftService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    staffMember: { findMany: jest.Mock };
    attendanceRecord: { findMany: jest.Mock; groupBy: jest.Mock };
    payslipItemMaster: { findMany: jest.Mock };
    payslip: { findFirst: jest.Mock; create: jest.Mock };
    store: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    calculate.mockReset().mockResolvedValue(NOTHING);
    attendanceReasons.mockReset().mockResolvedValue([]);
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      staffMember: { findMany: jest.fn().mockResolvedValue([staff()]) },
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([{ staffMemberId: 30 }]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      payslipItemMaster: { findMany: jest.fn().mockResolvedValue(MASTERS) },
      payslip: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ payslipId: 100 }),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 서초점' },
          { storeId: 6, name: '모리커피 청담점' },
        ]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        PayslipDraftService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(PayslipDraftService);
  });

  const staffWhere = () =>
    (prisma.staffMember.findMany.mock.calls as unknown[][])[0][0] as {
      where: { AND: Prisma.StaffMemberWhereInput[] };
      select: {
        contracts: { where: Prisma.ContractWhereInput; orderBy: unknown };
        payslips: { where: Prisma.PayslipWhereInput };
      };
    };
  const created = () =>
    (prisma.payslip.create.mock.calls as unknown[][])[0][0] as {
      data: Record<string, unknown> & {
        payslipItems: { createMany: { data: Record<string, unknown>[] } };
        payslipReviewReasons: {
          createMany: { data: Record<string, unknown>[] };
        };
        payslipLogs: { create: Record<string, unknown> };
      };
    };

  describe('candidates', () => {
    it('관리자 계정이 사용 중이 아니면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      expect(await service.candidates(9, '2026-10')).toBeNull();
    });

    it('관리 범위가 비면 직원을 읽지 않고 빈 목록', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [],
      });
      expect(await service.candidates(9, '2026-10')).toEqual({
        periodStartDate: '2026-10-01',
        periodEndDate: '2026-10-31',
        items: [],
      });
      expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('급여 기간은 그 달 1일 ~ 말일이고, 유효한 계약 · 이미 있는 명세서 · 출퇴근 기록을 함께 준다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff(),
        staff({
          staffMemberId: 31,
          storeId: 6,
          name: '이도윤',
          contracts: [],
          payslips: [{ payslipId: 55 }],
        }),
      ]);
      const result = await service.candidates(9, '2026-02');
      expect(result).toEqual({
        periodStartDate: '2026-02-01',
        periodEndDate: '2026-02-28',
        items: [
          {
            staffMemberId: 30,
            staffName: '서지안',
            storeId: 5,
            storeName: '모리커피 서초점',
            employmentType: 'PART_TIME',
            contractId: 7,
            payslipId: null,
            hasAttendance: true,
          },
          {
            staffMemberId: 31,
            staffName: '이도윤',
            storeId: 6,
            storeName: '모리커피 청담점',
            employmentType: 'FULL_TIME',
            contractId: null,
            payslipId: 55,
            hasAttendance: false,
          },
        ],
      });
    });

    it('유효한 계약은 체결 완료이고 급여 기간과 겹치는 것(종료일 없음 포함), 가장 늦게 시작한 것부터', async () => {
      await service.candidates(9, '2026-10');
      const { contracts } = staffWhere().select;
      expect(contracts.where).toEqual({
        status: 'SIGNED',
        startDate: { lte: d('2026-10-31') },
        OR: [{ endDate: null }, { endDate: { gte: d('2026-10-01') } }],
      });
      expect(contracts.orderBy).toEqual([
        { startDate: 'desc' },
        { contractId: 'desc' },
      ]);
    });

    it('이미 있는 명세서는 목록과 같이 급여 기간 시작일이 그 달인 것이다', async () => {
      await service.candidates(9, '2026-10');
      expect(staffWhere().select.payslips.where).toEqual({
        periodStartDate: { gte: d('2026-10-01'), lt: d('2026-11-01') },
      });
    });

    it('재직 중이거나, 그 달 유효한 계약 · 명세서가 있는 직원만 — 오래전 퇴직자는 빠진다', async () => {
      await service.candidates(9, '2026-10');
      expect(staffWhere().where.AND).toContainEqual({
        OR: [
          { employmentStatus: 'EMPLOYED' },
          {
            contracts: {
              some: expect.objectContaining({ status: 'SIGNED' }) as unknown,
            },
          },
          { payslips: { some: expect.any(Object) as unknown } },
        ],
      });
    });

    it('본사 역할에게 가맹 점포는 본사 제공 동의한 직원만 — 동의 없는 직원은 작성 대상에서 빠진다', async () => {
      await service.candidates(9, '2026-10');
      expect(staffWhere().where.AND[0]).toEqual({
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            account: { is: { isHqSharingConsented: true } },
          },
        ],
      });
    });

    it('가맹 역할은 관리 범위 전체를 가리지 않는다', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      await service.candidates(9, '2026-10');
      expect(staffWhere().where.AND[0]).toEqual({
        OR: [{ storeId: { in: [6] } }],
      });
    });

    it('출퇴근 기록은 한국 시간 그 달 1일 0시부터 다음 달 1일 0시 전까지 본다', async () => {
      await service.candidates(9, '2026-10');
      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: { in: [30] },
          recordedAt: {
            gte: new Date('2026-09-30T15:00:00.000Z'),
            lt: new Date('2026-10-31T15:00:00.000Z'),
          },
        },
        distinct: ['staffMemberId'],
        select: { staffMemberId: true },
      });
    });
  });

  describe('create', () => {
    it('관리자 계정이 사용 중이 아니면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      expect(await service.create(9, 30, '2026-10')).toBeNull();
      expect(prisma.payslip.create).not.toHaveBeenCalled();
    });

    it('관리 범위 밖 · 가려지는 · 없는 직원은 404', async () => {
      prisma.staffMember.findMany.mockResolvedValue([]);
      await expect(service.create(9, 30, '2026-10')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // 직원 하나만 찾을 때는 재직 · 계약 조건으로 거르지 않는다 — 퇴직자는 404 가 아니라 계약 없음(422)이다
      expect(staffWhere().where.AND).toEqual([
        expect.anything(),
        { staffMemberId: 30 },
      ]);
    });

    it('이 달 명세서가 이미 있으면 409 PAYSLIP_EXISTS 와 그 ID', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff({ payslips: [{ payslipId: 55 }] }),
      ]);
      await expect(service.create(9, 30, '2026-10')).rejects.toMatchObject({
        response: { code: 'PAYSLIP_EXISTS', payslipId: 55 },
      });
      expect(prisma.payslip.create).not.toHaveBeenCalled();
    });

    it('급여 기간에 유효한 근로계약이 없으면 422 NO_VALID_CONTRACT', async () => {
      prisma.staffMember.findMany.mockResolvedValue([staff({ contracts: [] })]);
      const error = await service
        .create(9, 30, '2026-10')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'NO_VALID_CONTRACT' } });
      expect(prisma.payslip.create).not.toHaveBeenCalled();
    });

    it('초안 — 작성 중 · 금액 0 · 계약 · 기간 · 출퇴근 참조 기간, 처리 이력 「초안 생성」', async () => {
      expect(await service.create(9, 30, '2026-10')).toEqual({
        payslipId: 100,
      });
      const { data } = created();
      expect(data).toMatchObject({
        staffMemberId: 30,
        storeId: 5,
        contractId: 7,
        periodStartDate: d('2026-10-01'),
        periodEndDate: d('2026-10-31'),
        attendanceStartDate: d('2026-10-01'),
        attendanceEndDate: d('2026-10-31'),
        employmentType: 'PART_TIME',
        status: 'DRAFTING',
        grossPayAmount: 0,
        totalDeductionAmount: 0,
        netPayAmount: 0,
      });
      expect(data.payslipLogs.create).toEqual({
        logType: 'DRAFT',
        fromStatus: null,
        toStatus: 'DRAFTING',
        summary: '초안 생성',
        changedBy: 9,
      });
      expect(created().data.payslipReviewReasons.createMany.data).toEqual([]);
    });

    it('기본급 · 주휴 · 연장은 계산값을 넣고 넣은 것으로 본다 — 지급 총액 = 실지급액, 계산은 그 가산 값으로(WHALEERP-227)', async () => {
      calculate.mockResolvedValue({ ...NOTHING, basePay: 650_000 });
      await service.create(9, 30, '2026-10');
      expect(calculate).toHaveBeenCalledWith(prisma, {
        staffMemberId: 30,
        contractId: 7,
        employmentType: 'PART_TIME',
        periodStartDate: d('2026-10-01'),
        periodEndDate: d('2026-10-31'),
        isPremiumApplied: true,
      });
      const { data } = created();
      expect(data).toMatchObject({
        grossPayAmount: 650_000,
        totalDeductionAmount: 0,
        netPayAmount: 650_000,
      });
      expect(data.payslipItems.createMany.data[0]).toMatchObject({
        payslipItemMasterId: 1,
        calculatedAmount: 650_000,
        adjustedAmount: null,
        isEntered: true,
      });
      expect(data.payslipItems.createMany.data[1]).toMatchObject({
        payslipItemMasterId: 9,
        calculatedAmount: null,
        isEntered: false,
      });
    });

    it('항목은 사용 중인 급여 항목의 지급 · 기본 공제(파트타이머는 원천징수도), 금액 없이 미입력으로 만든다', async () => {
      await service.create(9, 30, '2026-10');
      expect(prisma.payslipItemMaster.findMany).toHaveBeenCalledWith({
        where: {
          isActive: true,
          category: { in: ['EARNING', 'BASIC', 'WITHHOLDING'] },
        },
        orderBy: [{ sortOrder: 'asc' }, { payslipItemMasterId: 'asc' }],
        select: {
          payslipItemMasterId: true,
          itemCode: true,
          name: true,
          category: true,
          isTaxFree: true,
        },
      });
      expect(created().data.payslipItems.createMany.data).toEqual([
        {
          payslipItemMasterId: 1,
          itemCategory: 'EARNING',
          itemName: '기본급',
          isTaxFree: false,
          calculatedAmount: null,
          adjustedAmount: null,
          isEntered: false,
        },
        expect.objectContaining({ payslipItemMasterId: 9, isTaxFree: true }),
        expect.objectContaining({
          payslipItemMasterId: 12,
          itemCategory: 'BASIC',
        }),
        expect.objectContaining({
          payslipItemMasterId: 28,
          itemCategory: 'WITHHOLDING',
        }),
      ]);
    });

    it('정직원은 원천징수 항목을 만들지 않고 3.3% 를 끈 채로 시작한다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff({ contracts: [{ contractId: 7, employmentType: 'FULL_TIME' }] }),
      ]);
      await service.create(9, 30, '2026-10');
      const { data } = created();
      expect(data.isWithholdingApplied).toBe(false);
      expect(
        data.payslipItems.createMany.data.map((i) => i.itemCategory),
      ).toEqual(['EARNING', 'EARNING', 'BASIC']);
    });

    it('계약 유형이 비어 있으면 직원 레코드의 고용 형태를 쓴다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff({ contracts: [{ contractId: 7, employmentType: null }] }),
      ]);
      await service.create(9, 30, '2026-10');
      expect(created().data.employmentType).toBe('FULL_TIME');
    });

    it('지난 명세서가 없으면 가산 적용 · 파트타이머 3.3% 적용으로 시작한다(PAY-05 · PAY-03)', async () => {
      await service.create(9, 30, '2026-10');
      expect(created().data).toMatchObject({
        isPremiumApplied: true,
        isWithholdingApplied: true,
      });
      expect(prisma.payslip.findFirst).toHaveBeenCalledWith({
        where: { staffMemberId: 30, periodStartDate: { lt: d('2026-10-01') } },
        orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
        select: {
          isPremiumApplied: true,
          isWithholdingApplied: true,
          employmentType: true,
        },
      });
    });

    it('같은 직원의 지난 명세서 값을 가져온다', async () => {
      prisma.payslip.findFirst.mockResolvedValue({
        isPremiumApplied: false,
        isWithholdingApplied: false,
        employmentType: 'PART_TIME',
      });
      await service.create(9, 30, '2026-10');
      expect(created().data).toMatchObject({
        isPremiumApplied: false,
        isWithholdingApplied: false,
      });
    });

    it('지난 명세서가 정직원 것이면 3.3% 는 가져오지 않고 적용으로 시작한다', async () => {
      prisma.payslip.findFirst.mockResolvedValue({
        isPremiumApplied: false,
        isWithholdingApplied: false,
        employmentType: 'FULL_TIME',
      });
      await service.create(9, 30, '2026-10');
      expect(created().data).toMatchObject({
        isPremiumApplied: false,
        isWithholdingApplied: true,
      });
    });

    it('출퇴근 검토 대기 사유를 그 직원 · 계약 · 급여 기간으로 만들어 붙이고 그래도 만든다(WHALEERP-229)', async () => {
      const missing = {
        reviewReason: 'MISSING_ATTENDANCE',
        detail: '급여 기간에 출퇴근 기록이 없습니다',
      };
      attendanceReasons.mockResolvedValue([missing]);
      expect(await service.create(9, 30, '2026-10')).toEqual({
        payslipId: 100,
      });
      expect(attendanceReasons).toHaveBeenCalledWith(prisma, {
        staffMemberId: 30,
        contractIds: [7],
        periodStartDate: d('2026-10-01'),
        periodEndDate: d('2026-10-31'),
      });
      expect(created().data.payslipReviewReasons.createMany.data).toEqual([
        missing,
      ]);
      expect(created().data.status).toBe('DRAFTING');
    });

    it('사유 순서 — 출퇴근 누락 · 기간 중 계약 변경 · 계약 만료 후 기록 · 확인 필요 기록 포함', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff({
          contracts: [
            { contractId: 8, employmentType: 'PART_TIME' },
            { contractId: 7, employmentType: 'PART_TIME' },
          ],
        }),
      ]);
      attendanceReasons.mockResolvedValue([
        { reviewReason: 'MISSING_ATTENDANCE', detail: 'a' },
        { reviewReason: 'AFTER_CONTRACT_END', detail: 'b' },
        { reviewReason: 'ATTENDANCE_NEEDS_REVIEW', detail: 'c' },
      ]);
      await service.create(9, 30, '2026-10');
      expect(
        created().data.payslipReviewReasons.createMany.data.map(
          (r) => r.reviewReason,
        ),
      ).toEqual([
        'MISSING_ATTENDANCE',
        'CONTRACT_CHANGED',
        'AFTER_CONTRACT_END',
        'ATTENDANCE_NEEDS_REVIEW',
      ]);
    });

    it('급여 기간에 걸친 계약이 둘 이상이면 가장 늦게 시작한 계약을 참조하고 「기간 중 계약 변경」 사유를 붙인다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff({
          contracts: [
            { contractId: 8, employmentType: 'PART_TIME' },
            { contractId: 7, employmentType: 'PART_TIME' },
          ],
        }),
      ]);
      await service.create(9, 30, '2026-10');
      expect(created().data.contractId).toBe(8);
      expect(created().data.payslipReviewReasons.createMany.data).toEqual([
        {
          reviewReason: 'CONTRACT_CHANGED',
          detail:
            '급여 기간에 근로계약이 2건 걸쳐 있어 가장 늦게 시작한 계약을 참조했습니다',
        },
      ]);
    });

    it('동시에 같은 명세서를 만들어 유일 제약에 걸리면 409', async () => {
      prisma.payslip.create.mockRejectedValue(uniqueViolation());
      await expect(service.create(9, 30, '2026-10')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('bulkCreate', () => {
    it('관리자 계정이 사용 중이 아니면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      expect(await service.bulkCreate(9, '2026-10')).toBeNull();
    });

    it('관리 범위의 작성 대상 모두 — 만든 것과 건너뛴 것(이미 있음 · 계약 없음)을 나눠 준다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        staff(),
        staff({
          staffMemberId: 31,
          name: '이도윤',
          payslips: [{ payslipId: 55 }],
        }),
        staff({ staffMemberId: 32, name: '박서윤', contracts: [] }),
        staff({ staffMemberId: 33, name: '최하준' }),
      ]);
      prisma.payslip.create
        .mockResolvedValueOnce({ payslipId: 100 })
        .mockResolvedValueOnce({ payslipId: 101 });
      expect(await service.bulkCreate(9, '2026-10')).toEqual({
        created: [
          {
            payslipId: 100,
            staffMemberId: 30,
            staffName: '서지안',
            hasMissingAttendance: false,
          },
          {
            payslipId: 101,
            staffMemberId: 33,
            staffName: '최하준',
            hasMissingAttendance: true,
          },
        ],
        skipped: [
          { staffMemberId: 31, staffName: '이도윤', reason: 'EXISTS' },
          { staffMemberId: 32, staffName: '박서윤', reason: 'NO_CONTRACT' },
        ],
      });
      // 직원마다 따로 트랜잭션 — 한 명이 실패해도 앞서 만든 초안은 남는다
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.payslipItemMaster.findMany).toHaveBeenCalledTimes(1);
    });

    it('그사이 다른 요청이 같은 명세서를 만들었으면 이미 있음으로 건너뛴다', async () => {
      prisma.payslip.create.mockRejectedValue(uniqueViolation());
      expect(await service.bulkCreate(9, '2026-10')).toEqual({
        created: [],
        skipped: [{ staffMemberId: 30, staffName: '서지안', reason: 'EXISTS' }],
      });
    });

    it('유일 제약 밖의 오류는 그대로 던진다', async () => {
      prisma.payslip.create.mockRejectedValue(new Error('boom'));
      await expect(service.bulkCreate(9, '2026-10')).rejects.toThrow('boom');
    });
  });
});
