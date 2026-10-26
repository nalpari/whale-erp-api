import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  attendanceReviewReasons,
  periodContractIds,
} from './payslip-attendance-reasons';
import { calculatePayslip } from './payslip-calculation';
import { PayslipEditService } from './payslip-edit.service';
import { PayslipListService } from './payslip-list.service';

// 금액 계산(WHALEERP-227)은 pay-calculation.spec 이 본다. 여기서는 계산값이 줄 · 합계 · 이력으로 옮겨지는지만 본다.
jest.mock('./payslip-calculation', () => ({
  ...jest.requireActual<object>('./payslip-calculation'),
  calculatePayslip: jest.fn(),
}));
const calculate = calculatePayslip as jest.Mock;
jest.mock('./payslip-attendance-reasons', () => ({
  ...jest.requireActual<object>('./payslip-attendance-reasons'),
  attendanceReviewReasons: jest.fn(),
  periodContractIds: jest.fn(),
}));
const attendanceReasons = attendanceReviewReasons as jest.Mock;
const contractIdsOf = periodContractIds as jest.Mock;
const pay = (over: object = {}) => ({
  basePay: 1_000_000,
  weeklyHolidayPay: 0,
  overtimePay: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
  weeklyHolidayWeeks: 0,
  ...over,
});

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const UPDATED = '2026-10-19T01:00:00.000Z';

const located = (over: object = {}) => ({
  storeId: 5,
  staffMemberId: 30,
  status: 'DRAFTING',
  employmentType: 'PART_TIME',
  periodStartDate: d('2026-10-01'),
  periodEndDate: d('2026-10-31'),
  isPremiumApplied: true,
  isWithholdingApplied: true,
  staffMember: { account: { isHqSharingConsented: false } },
  ...over,
});

const master = (id: number, itemCode: string, isSystemCalculated = false) => ({
  payslipItemMasterId: id,
  itemCode,
  isSystemCalculated,
});
const line = (
  id: number,
  category: string,
  itemName: string,
  m: ReturnType<typeof master>,
  over: object = {},
) => ({
  payslipItemId: id,
  itemCategory: category,
  payslipItemMasterId: m.payslipItemMasterId,
  itemName,
  calculatedAmount: null,
  adjustedAmount: null,
  isEntered: false,
  payslipItemMaster: m,
  ...over,
});

const BASE = master(1, 'BASE_PAY', true);
const BONUS = master(8, 'BONUS');
const MEAL = master(9, 'MEAL_ALLOWANCE');
const PENSION = master(12, 'NATIONAL_PENSION');
const INCOME_TAX = master(16, 'INCOME_TAX');
const SETTLEMENT = master(18, 'YEAR_END_SETTLEMENT');
const STOCK = master(27, 'STOCK_OPTION');
const BIZ_TAX = master(28, 'BUSINESS_INCOME_TAX');

const lines = () => [
  line(101, 'EARNING', '기본급', BASE, {
    calculatedAmount: 1_000_000,
    isEntered: true,
  }),
  line(108, 'EARNING', '상여', BONUS),
  line(109, 'EARNING', '식대', MEAL),
  line(112, 'BASIC', '국민연금', PENSION),
  line(116, 'BASIC', '소득세', INCOME_TAX),
  line(128, 'WITHHOLDING', '사업소득세(3%)', BIZ_TAX),
  line(127, 'ADDITIONAL', '스톡옵션', STOCK, {
    adjustedAmount: 5_000,
    isEntered: true,
  }),
];

describe('PayslipEditService', () => {
  let service: PayslipEditService;
  let scope: { getManageableStores: jest.Mock };
  let detail: { findOne: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    payslip: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    payslipItem: {
      findMany: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    payslipItemMaster: { findMany: jest.Mock };
    payslipReviewReason: {
      updateMany: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      createMany: jest.Mock;
    };
    payslipLog: { create: jest.Mock };
  };

  beforeEach(async () => {
    calculate.mockReset().mockResolvedValue(pay());
    attendanceReasons.mockReset().mockResolvedValue([]);
    contractIdsOf.mockReset().mockResolvedValue([7]);
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    detail = { findOne: jest.fn().mockResolvedValue({ payslipId: 40 }) };
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      payslip: {
        findFirst: jest.fn().mockResolvedValue(located()),
        findUnique: jest.fn().mockResolvedValue({ status: 'DRAFTING' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      payslipItem: {
        findMany: jest.fn().mockResolvedValue(lines()),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      payslipItemMaster: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...SETTLEMENT,
            name: '연말(중도)정산',
            category: 'ADDITIONAL',
            isTaxFree: false,
          },
        ]),
      },
      payslipReviewReason: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      payslipLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const module = await Test.createTestingModule({
      providers: [
        PayslipEditService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: PayslipListService, useValue: detail },
      ],
    }).compile();
    service = module.get(PayslipEditService);
  });

  type Args = { where: unknown; data: Record<string, unknown> };
  const call = (mock: jest.Mock, i = 0) =>
    (mock.mock.calls as unknown[][])[i][0] as Args;
  const logSummary = () => call(prisma.payslipLog.create).data.summary;
  const save = (over: object = {}) =>
    service.save(9, 40, {
      updatedAt: UPDATED,
      isPremiumApplied: true,
      isWithholdingApplied: true,
      items: [],
      ...over,
    });

  describe('명세서 찾기(관리 범위 · 가림)', () => {
    it('범위 밖 · 없는 명세서는 404', async () => {
      prisma.payslip.findFirst.mockResolvedValue(null);
      await expect(save()).rejects.toBeInstanceOf(NotFoundException);
      expect(call(prisma.payslip.findFirst).where).toEqual({
        payslipId: 40,
        storeId: { in: [5, 6] },
      });
    });

    it('본사 역할에게 동의 없는 가맹 점포 직원 명세서는 404 — 상세와 같다', async () => {
      prisma.payslip.findFirst.mockResolvedValue(located({ storeId: 6 }));
      await expect(save()).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.confirm(9, 40, { updatedAt: UPDATED }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.previousValues(9, 40)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('관리자 계정을 쓸 수 없으면 404', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      await expect(save()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('save (임시저장, WHALEERP-228)', () => {
    it('작성 중 · 검토 중만 — 확정 · 발송 완료는 409', async () => {
      prisma.payslip.findFirst.mockResolvedValue(
        located({ status: 'CONFIRMED' }),
      );
      await expect(save()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT', status: 'CONFIRMED' },
      });
      expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
    });

    it('정직원 명세서에 3.3% 를 켜면 400', async () => {
      prisma.payslip.findFirst.mockResolvedValue(
        located({ employmentType: 'FULL_TIME', isWithholdingApplied: false }),
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('같은 항목을 두 번 실으면 400', async () => {
      await expect(
        save({
          items: [
            { payslipItemMasterId: 12, amount: 1 },
            { payslipItemMasterId: 12, amount: 2 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('읽은 updatedAt 과 상태를 조건으로 먼저 고친다 — 그사이 바뀌었으면 409 PAYSLIP_STALE', async () => {
      prisma.payslip.updateMany.mockResolvedValue({ count: 0 });
      await expect(save()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STALE' },
      });
      const { where, data } = call(prisma.payslip.updateMany);
      expect(where).toEqual({
        payslipId: 40,
        status: 'DRAFTING',
        updatedAt: {
          gte: new Date(UPDATED),
          lt: new Date(new Date(UPDATED).getTime() + 1),
        },
      });
      expect(data).toEqual({
        isPremiumApplied: true,
        isWithholdingApplied: true,
      });
    });

    it('지급 · 공제 값을 넣고 합계를 다시 셈한다 — 0 과 미입력을 가른다', async () => {
      await save({
        isWithholdingApplied: false,
        items: [
          { payslipItemMasterId: 8, amount: 200_000 },
          { payslipItemMasterId: 9, amount: 0 },
          { payslipItemMasterId: 12, amount: 45_000 },
          { payslipItemMasterId: 16, amount: null },
          { payslipItemMasterId: 27, amount: 5_000 },
        ],
      });
      const updates = prisma.payslipItem.update.mock.calls.map(
        (c: [{ where: object; data: object }]) => c[0],
      );
      expect(updates).toEqual(
        expect.arrayContaining([
          {
            where: { payslipItemId: 108 },
            data: { adjustedAmount: 200_000, isEntered: true },
          },
          {
            where: { payslipItemId: 109 },
            data: { adjustedAmount: 0, isEntered: true },
          },
          {
            where: { payslipItemId: 112 },
            data: { adjustedAmount: 45_000, isEntered: true },
          },
        ]),
      );
      // 바뀌지 않은 줄(소득세 미입력 → 미입력, 스톡옵션 5,000 → 5,000)은 쓰지 않는다
      expect(updates).toHaveLength(3);
      // 지급 1,000,000 + 200,000 + 0, 공제 45,000 + 스톡옵션 5,000(원천징수는 꺼져 있어 세지 않음)
      expect(call(prisma.payslip.update)).toEqual({
        where: { payslipId: 40 },
        data: {
          grossPayAmount: 1_200_000,
          totalDeductionAmount: 50_000,
          netPayAmount: 1_150_000,
        },
      });
    });

    it('3.3% 를 켜면 소득세 · 지방소득세는 공제 합계에서 빠지고 원천징수 줄이 들어간다', async () => {
      prisma.payslipItem.findMany.mockResolvedValue(
        lines().map((l) =>
          l.payslipItemId === 116
            ? { ...l, adjustedAmount: 30_000, isEntered: true }
            : l.payslipItemId === 128
              ? { ...l, adjustedAmount: 33_000, isEntered: true }
              : l,
        ),
      );
      await save({ items: [{ payslipItemMasterId: 27, amount: 5_000 }] });
      expect(call(prisma.payslip.update).data).toEqual({
        grossPayAmount: 1_000_000,
        totalDeductionAmount: 38_000,
        netPayAmount: 962_000,
      });
    });

    it('시스템 계산 항목은 고친 값이 계산값과 같거나 null 이면 계산값으로 돌린다', async () => {
      prisma.payslipItem.findMany.mockResolvedValue(
        lines().map((l) =>
          l.payslipItemId === 101 ? { ...l, adjustedAmount: 900_000 } : l,
        ),
      );
      await save({
        items: [
          { payslipItemMasterId: 1, amount: 1_000_000 },
          { payslipItemMasterId: 27, amount: 5_000 },
        ],
      });
      expect(call(prisma.payslipItem.update)).toEqual({
        where: { payslipItemId: 101 },
        data: { adjustedAmount: null, isEntered: true },
      });
    });

    it('추가 공제는 실은 것이 곧 붙은 목록이다 — 새 항목은 이름 · 구분을 박아 붙이고, 빠진 것은 뗀다', async () => {
      await save({
        isWithholdingApplied: false,
        items: [{ payslipItemMasterId: 18, amount: null }],
      });
      expect(call(prisma.payslipItemMaster.findMany).where).toEqual({
        payslipItemMasterId: { in: [18] },
        isActive: true,
        category: 'ADDITIONAL',
      });
      expect(call(prisma.payslipItem.create)).toEqual({
        data: {
          payslipId: 40,
          payslipItemMasterId: 18,
          itemCategory: 'ADDITIONAL',
          itemName: '연말(중도)정산',
          isTaxFree: false,
          calculatedAmount: null,
          adjustedAmount: null,
          isEntered: false,
        },
      });
      expect(call(prisma.payslipItem.deleteMany)).toEqual({
        where: { payslipItemId: { in: [127] } },
      });
      expect(logSummary()).toBe(
        '3.3% 원천징수 해제 · 항목 추가 연말(중도)정산 · 항목 삭제 스톡옵션',
      );
    });

    it('붙일 수 없는 항목(사용 안 함 · 추가 공제가 아님 · 없는 항목)은 400', async () => {
      prisma.payslipItemMaster.findMany.mockResolvedValue([]);
      await expect(
        save({ items: [{ payslipItemMasterId: 99, amount: 1 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('바꾼 것을 처리 이력(수정)에 한 줄로 남긴다 — 상태는 그대로', async () => {
      await save({
        isPremiumApplied: false,
        items: [
          { payslipItemMasterId: 8, amount: 128_000 },
          { payslipItemMasterId: 27, amount: 0 },
        ],
      });
      expect(call(prisma.payslipLog.create)).toEqual({
        data: {
          payslipId: 40,
          logType: 'EDIT',
          fromStatus: null,
          toStatus: null,
          summary:
            '가산 적용 해제 · 상여 미입력 → 128,000원 · 스톡옵션 5,000원 → 0원',
          changedBy: 9,
        },
      });
    });

    it('바뀐 것이 없으면 이력을 남기지 않는다', async () => {
      await save({ items: [{ payslipItemMasterId: 27, amount: 5_000 }] });
      expect(prisma.payslipLog.create).not.toHaveBeenCalled();
    });

    it('합계가 integer 범위를 넘으면 400', async () => {
      prisma.payslipItem.findMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) =>
          line(200 + i, 'EARNING', `지급${i}`, master(300 + i, `E${i}`)),
        ),
      );
      await expect(
        save({
          items: Array.from({ length: 25 }, (_, i) => ({
            payslipItemMasterId: 300 + i,
            amount: 100_000_000,
          })),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('저장한 뒤 상세를 돌려준다', async () => {
      await expect(save()).resolves.toEqual({ payslipId: 40 });
      expect(detail.findOne).toHaveBeenCalledWith(9, 40);
    });

    it('가산 적용을 그대로 두면 다시 계산하지 않는다', async () => {
      await save();
      expect(calculate).not.toHaveBeenCalled();
    });

    describe('가산 적용을 바꾸면', () => {
      const OVERTIME = master(3, 'OVERTIME_PAY', true);
      const withOvertime = (over: object = {}) => [
        line(101, 'EARNING', '기본급', BASE, {
          calculatedAmount: 1_000_000,
          adjustedAmount: 950_000,
          isEntered: true,
        }),
        line(103, 'EARNING', '연장수당', OVERTIME, {
          calculatedAmount: 30_000,
          isEntered: true,
          ...over,
        }),
      ];
      const updateOf = (id: number) =>
        (prisma.payslipItem.update.mock.calls as [{ where: object }][])
          .map((c) => c[0])
          .find(
            (c) => (c.where as { payslipItemId: number }).payslipItemId === id,
          );

      it('연장수당만 그 값으로 다시 계산한다 — 고친 기본급은 그대로, 바꾸기 전과 같은 값을 보낸 연장수당은 새 계산값(WHALEERP-227)', async () => {
        prisma.payslipItem.findMany.mockResolvedValue(withOvertime());
        calculate.mockResolvedValue(
          pay({ basePay: 1_100_000, overtimePay: 20_000 }),
        );
        await save({
          isPremiumApplied: false,
          items: [
            { payslipItemMasterId: 1, amount: 950_000 },
            { payslipItemMasterId: 3, amount: 30_000 },
          ],
        });
        expect(calculate).toHaveBeenCalledWith(
          prisma,
          expect.objectContaining({
            staffMemberId: 30,
            contractIds: [7],
            isPremiumApplied: false,
          }),
        );
        expect(updateOf(103)).toEqual({
          where: { payslipItemId: 103 },
          data: {
            calculatedAmount: 20_000,
            adjustedAmount: null,
            isEntered: true,
          },
        });
        expect(updateOf(101)).toBeUndefined();
        expect(logSummary()).toBe(
          '가산 적용 해제 · 연장수당 30,000원 → 20,000원',
        );
      });

      it('관리자가 고친 연장수당은 남긴다', async () => {
        prisma.payslipItem.findMany.mockResolvedValue(withOvertime());
        calculate.mockResolvedValue(pay({ overtimePay: 20_000 }));
        await save({
          isPremiumApplied: false,
          items: [
            { payslipItemMasterId: 1, amount: 950_000 },
            { payslipItemMasterId: 3, amount: 45_000 },
          ],
        });
        expect(updateOf(103)!).toMatchObject({
          data: {
            calculatedAmount: 20_000,
            adjustedAmount: 45_000,
            isEntered: true,
          },
        });
      });
    });
  });

  describe('recalculate (출퇴근으로 다시 계산, WHALEERP-227)', () => {
    const recalculate = () =>
      service.recalculate(9, 40, { updatedAt: UPDATED });

    it('작성 중 · 검토 중만 — 확정 · 발송 완료는 409', async () => {
      prisma.payslip.findFirst.mockResolvedValue(located({ status: 'SENT' }));
      await expect(recalculate()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT', status: 'SENT' },
      });
      expect(calculate).not.toHaveBeenCalled();
    });

    it('계산값으로 다시 채우고 고친 값은 버린다 — 합계를 다시 셈하고 이력을 남긴다', async () => {
      prisma.payslipItem.findMany.mockResolvedValue([
        line(101, 'EARNING', '기본급', BASE, {
          calculatedAmount: 1_000_000,
          adjustedAmount: 900_000,
          isEntered: true,
        }),
        line(127, 'ADDITIONAL', '스톡옵션', STOCK, {
          adjustedAmount: 5_000,
          isEntered: true,
        }),
      ]);
      calculate.mockResolvedValue(pay({ basePay: 1_050_000 }));
      await expect(recalculate()).resolves.toEqual({ payslipId: 40 });
      expect(call(prisma.payslip.updateMany).where).toMatchObject({
        payslipId: 40,
        status: 'DRAFTING',
      });
      expect(call(prisma.payslipItem.update)).toEqual({
        where: { payslipItemId: 101 },
        data: {
          calculatedAmount: 1_050_000,
          adjustedAmount: null,
          isEntered: true,
        },
      });
      expect(call(prisma.payslip.update).data).toEqual({
        grossPayAmount: 1_050_000,
        totalDeductionAmount: 5_000,
        netPayAmount: 1_045_000,
      });
      expect(logSummary()).toBe(
        '출퇴근으로 다시 계산 · 기본급 900,000원 → 1,050,000원',
      );
    });

    it('바뀐 것이 없어도 다시 계산한 줄은 이력에 남긴다', async () => {
      await recalculate();
      expect(prisma.payslipItem.update).not.toHaveBeenCalled();
      expect(logSummary()).toBe('출퇴근으로 다시 계산');
    });

    it('검토 대기 사유를 지금 데이터로 모두 새로 판정한다 — 확인한 표시도 지우고, 확인했던 종류도 다시 붙인다(WHALEERP-229, 2026-10-26)', async () => {
      prisma.payslipReviewReason.findMany.mockResolvedValue([
        { reviewReason: 'MISSING_ATTENDANCE' },
        { reviewReason: 'ATTENDANCE_NEEDS_REVIEW' },
      ]);
      attendanceReasons.mockResolvedValue([
        { reviewReason: 'AFTER_CONTRACT_END', detail: '만료 뒤 1일' },
        { reviewReason: 'ATTENDANCE_NEEDS_REVIEW', detail: '2건' },
      ]);
      await recalculate();
      expect(attendanceReasons).toHaveBeenCalledWith(prisma, {
        staffMemberId: 30,
        contractIds: [7],
        periodStartDate: d('2026-10-01'),
        periodEndDate: d('2026-10-31'),
      });
      const where = {
        payslipId: 40,
        reviewReason: {
          in: [
            'MISSING_ATTENDANCE',
            'AFTER_CONTRACT_END',
            'ATTENDANCE_NEEDS_REVIEW',
            'CONTRACT_CHANGED',
          ],
        },
      };
      // 확인 여부를 가리지 않고 지운다 — 공제 미입력은 건드리지 않는다(확정이 막는다)
      expect(call(prisma.payslipReviewReason.deleteMany).where).toEqual(where);
      expect(call(prisma.payslipReviewReason.createMany).data).toEqual([
        {
          reviewReason: 'AFTER_CONTRACT_END',
          detail: '만료 뒤 1일',
          payslipId: 40,
        },
        {
          reviewReason: 'ATTENDANCE_NEEDS_REVIEW',
          detail: '2건',
          payslipId: 40,
        },
      ]);
      expect(logSummary()).toBe(
        '출퇴근으로 다시 계산 · 출퇴근 누락 해소 · 계약 만료 후 기록 추가',
      );
    });

    it('급여 기간에 걸친 계약이 둘 이상이면 모든 계약으로 계산하고 「기간 중 계약 변경」을 다시 붙인다', async () => {
      contractIdsOf.mockResolvedValue([8, 7]);
      await recalculate();
      expect(contractIdsOf).toHaveBeenCalledWith(
        prisma,
        30,
        d('2026-10-01'),
        d('2026-10-31'),
      );
      expect(calculate).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ contractIds: [8, 7] }),
      );
      expect(call(prisma.payslipReviewReason.createMany).data).toEqual([
        {
          reviewReason: 'CONTRACT_CHANGED',
          detail:
            '급여 기간에 근로계약이 2건 걸쳐 있어 날마다 그날 효력이 있는 계약으로 나눠 계산했습니다',
          payslipId: 40,
        },
      ]);
      expect(logSummary()).toBe(
        '출퇴근으로 다시 계산 · 기간 중 계약 변경 추가',
      );
    });
  });

  describe('confirm (확정, WHALEERP-230)', () => {
    const confirm = () => service.confirm(9, 40, { updatedAt: UPDATED });

    it('보이는 공제(기본 · 붙인 추가, 3.3% 를 켜면 소득세 · 지방소득세 대신 원천징수)가 비어 있으면 422 와 그 항목', async () => {
      const error = await confirm().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      // 3.3% 켜짐: 소득세는 빠지고 국민연금 · 사업소득세가 비어 있다. 스톡옵션은 넣었다
      expect(error).toMatchObject({
        response: {
          code: 'DEDUCTION_MISSING',
          items: [
            { payslipItemId: 112, itemName: '국민연금' },
            { payslipItemId: 128, itemName: '사업소득세(3%)' },
          ],
        },
      });
    });

    it('공제가 모두 있으면 확정 — 검토 사유를 확인한 것으로 남기고 처리 이력(확정)', async () => {
      prisma.payslipItem.findMany.mockResolvedValue(
        lines().map((l) =>
          l.itemCategory === 'EARNING'
            ? l
            : { ...l, adjustedAmount: 0, isEntered: true },
        ),
      );
      prisma.payslipReviewReason.updateMany.mockResolvedValue({ count: 2 });
      await expect(confirm()).resolves.toEqual({ payslipId: 40 });
      const { where, data } = call(prisma.payslip.updateMany);
      expect(where).toMatchObject({ payslipId: 40, status: 'DRAFTING' });
      expect(data).toMatchObject({ status: 'CONFIRMED', confirmedBy: 9 });
      expect(data.confirmedAt).toBeInstanceOf(Date);
      expect(call(prisma.payslipReviewReason.updateMany)).toEqual({
        where: { payslipId: 40, acknowledgedAt: null },
        data: { acknowledgedAt: data.confirmedAt },
      });
      expect(call(prisma.payslipLog.create).data).toEqual({
        payslipId: 40,
        logType: 'CONFIRM',
        fromStatus: 'DRAFTING',
        toStatus: 'CONFIRMED',
        summary: '확정 · 검토 사유 2건 확인',
        changedBy: 9,
      });
    });

    it('이미 확정 · 발송이면 409, 그사이 고쳐졌으면 409 PAYSLIP_STALE', async () => {
      prisma.payslip.findFirst.mockResolvedValue(located({ status: 'SENT' }));
      await expect(confirm()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT' },
      });
      prisma.payslip.findFirst.mockResolvedValue(located());
      prisma.payslip.updateMany.mockResolvedValue({ count: 0 });
      await expect(confirm()).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancelConfirmation (확정 취소, WHALEERP-230)', () => {
    const cancel = () =>
      service.cancelConfirmation(9, 40, { updatedAt: UPDATED });

    it('확정 · 발송 완료에서 검토 중으로 — 확정 일시 · 관리자를 비우고 처리 이력(확정 취소)', async () => {
      for (const status of ['CONFIRMED', 'SENT']) {
        prisma.payslip.findFirst.mockResolvedValue(located({ status }));
        prisma.payslip.updateMany.mockClear();
        prisma.payslipLog.create.mockClear();
        await expect(cancel()).resolves.toEqual({ payslipId: 40 });
        expect(call(prisma.payslip.updateMany)).toMatchObject({
          where: { payslipId: 40, status },
          data: { status: 'REVIEWING', confirmedAt: null, confirmedBy: null },
        });
        expect(call(prisma.payslipLog.create).data).toEqual({
          payslipId: 40,
          logType: 'CANCEL_CONFIRMATION',
          fromStatus: status,
          toStatus: 'REVIEWING',
          summary: '확정 취소',
          changedBy: 9,
        });
      }
    });

    it('작성 중 · 검토 중은 409', async () => {
      prisma.payslip.findFirst.mockResolvedValue(
        located({ status: 'REVIEWING' }),
      );
      await expect(cancel()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT' },
      });
    });
  });

  describe('previousValues (지난 명세서 불러오기, WHALEERP-228)', () => {
    it('같은 직원의 앞선 명세서 중 가장 늦은 것의 공제 · 관리자 입력 지급 값(넣은 것만)', async () => {
      prisma.payslip.findFirst
        .mockResolvedValueOnce(located())
        .mockResolvedValueOnce({
          payslipId: 39,
          periodStartDate: d('2026-09-01'),
          periodEndDate: d('2026-09-30'),
          payslipItems: [
            line(1, 'EARNING', '기본급', BASE, {
              calculatedAmount: 9,
              isEntered: true,
            }),
            line(2, 'EARNING', '상여', BONUS, {
              adjustedAmount: 100,
              isEntered: true,
            }),
            line(3, 'EARNING', '식대', MEAL),
            line(4, 'BASIC', '국민연금', PENSION, {
              adjustedAmount: 0,
              isEntered: true,
            }),
            line(5, 'ADDITIONAL', '스톡옵션', STOCK, {
              adjustedAmount: 7,
              isEntered: true,
            }),
          ],
        });
      expect(await service.previousValues(9, 40)).toEqual({
        previous: {
          payslipId: 39,
          periodStartDate: '2026-09-01',
          periodEndDate: '2026-09-30',
          items: [
            {
              payslipItemMasterId: 8,
              itemCode: 'BONUS',
              itemName: '상여',
              itemCategory: 'EARNING',
              amount: 100,
            },
            {
              payslipItemMasterId: 12,
              itemCode: 'NATIONAL_PENSION',
              itemName: '국민연금',
              itemCategory: 'BASIC',
              amount: 0,
            },
            {
              payslipItemMasterId: 27,
              itemCode: 'STOCK_OPTION',
              itemName: '스톡옵션',
              itemCategory: 'ADDITIONAL',
              amount: 7,
            },
          ],
        },
      });
      expect(call(prisma.payslip.findFirst, 1).where).toEqual({
        staffMemberId: 30,
        periodStartDate: { lt: d('2026-10-01') },
      });
    });

    it('지난 명세서가 없으면 previous: null', async () => {
      prisma.payslip.findFirst
        .mockResolvedValueOnce(located())
        .mockResolvedValueOnce(null);
      expect(await service.previousValues(9, 40)).toEqual({ previous: null });
    });
  });

  it('additionalItems — 사용 중인 추가 공제 항목, 순서대로', async () => {
    prisma.payslipItemMaster.findMany.mockResolvedValue([
      {
        payslipItemMasterId: 18,
        itemCode: 'YEAR_END_SETTLEMENT',
        name: '연말(중도)정산',
      },
    ]);
    expect(await service.additionalItems()).toEqual({
      items: [
        {
          payslipItemMasterId: 18,
          itemCode: 'YEAR_END_SETTLEMENT',
          name: '연말(중도)정산',
        },
      ],
    });
    expect(call(prisma.payslipItemMaster.findMany)).toEqual({
      where: { isActive: true, category: 'ADDITIONAL' },
      orderBy: [{ sortOrder: 'asc' }, { payslipItemMasterId: 'asc' }],
      select: { payslipItemMasterId: true, itemCode: true, name: true },
    });
  });
});
