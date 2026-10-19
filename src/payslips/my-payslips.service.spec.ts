import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MyPayslipsService } from './my-payslips.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date('2026-10-19T03:00:00.000Z');

const summary = (over: object = {}) => ({
  payslipId: 40,
  storeId: 5,
  periodStartDate: d('2026-09-01'),
  periodEndDate: d('2026-09-30'),
  employmentType: 'PART_TIME',
  status: 'SENT',
  grossPayAmount: 1_000_000,
  totalDeductionAmount: 33_000,
  netPayAmount: 967_000,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  payslipLogs: [
    {
      payslipLogId: 12,
      logType: 'SEND',
      changedAt: new Date('2026-10-12T00:00:00.000Z'),
    },
    {
      payslipLogId: 11,
      logType: 'CANCEL_CONFIRMATION',
      changedAt: new Date('2026-10-11T00:00:00.000Z'),
    },
    {
      payslipLogId: 10,
      logType: 'SEND',
      changedAt: new Date('2026-10-10T00:00:00.000Z'),
    },
  ],
  ...over,
});

const item = {
  payslipItemId: 1,
  itemCategory: 'EARNING',
  itemName: '기본급',
  isTaxFree: false,
  calculatedAmount: 1_000_000,
  adjustedAmount: null,
  isEntered: true,
  payslipItemMaster: { itemCode: 'BASE_PAY' },
};

describe('MyPayslipsService', () => {
  let service: MyPayslipsService;
  let prisma: {
    payslip: { findMany: jest.Mock; findFirst: jest.Mock };
    store: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      payslip: {
        findMany: jest.fn().mockResolvedValue([summary()]),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            summary({ isWithholdingApplied: true, payslipItems: [item] }),
          ),
      },
      store: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ storeId: 5, name: '웨일카페 강남역점' }]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        MyPayslipsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MyPayslipsService);
  });

  const firstArg = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [Record<string, unknown>])[0];

  /** 발송 완료 · 본인 계정의 직원 레코드(재직 상태 무관 — 퇴직해도) · 만든 지 3년 안. */
  const MINE = {
    status: 'SENT',
    staffMember: { accountId: 3 },
    createdAt: { gt: new Date('2023-10-19T03:00:00.000Z') },
  };

  const shown = {
    payslipId: 40,
    periodStartDate: '2026-09-01',
    periodEndDate: '2026-09-30',
    employmentType: 'PART_TIME',
    status: 'SENT',
    grossPayAmount: 1_000_000,
    totalDeductionAmount: 33_000,
    netPayAmount: 967_000,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    storeName: '웨일카페 강남역점',
    logs: [
      {
        payslipLogId: 12,
        logType: 'SEND',
        changedAt: new Date('2026-10-12T00:00:00.000Z'),
      },
      {
        payslipLogId: 11,
        logType: 'CANCEL_CONFIRMATION',
        changedAt: new Date('2026-10-11T00:00:00.000Z'),
      },
      {
        payslipLogId: 10,
        logType: 'SEND',
        changedAt: new Date('2026-10-10T00:00:00.000Z'),
      },
    ],
  };

  describe('list', () => {
    it('발송된 본인 명세서만, 보존 기간(3년) 안에서 — 퇴직 여부는 보지 않는다', async () => {
      await service.list(3, NOW);
      const args = firstArg(prisma.payslip.findMany);
      expect(args.where).toEqual(MINE);
      expect(args.orderBy).toEqual([
        { periodStartDate: 'desc' },
        { payslipId: 'desc' },
      ]);
    });

    it('3년 경계는 같은 시각까지 — 2월 29일은 setUTCFullYear 규칙(3월 1일)', async () => {
      await service.list(3, new Date('2028-02-29T00:00:00.000Z'));
      expect(
        (firstArg(prisma.payslip.findMany).where as typeof MINE).createdAt,
      ).toEqual({ gt: new Date('2025-03-01T00:00:00.000Z') });
    });

    it('처리 이력은 발송 · 확정 취소만, 최근 것이 위', async () => {
      await service.list(3, NOW);
      const select = firstArg(prisma.payslip.findMany).select as Record<
        string,
        unknown
      >;
      expect(select.payslipLogs).toEqual({
        where: { logType: { in: ['SEND', 'CANCEL_CONFIRMATION'] } },
        orderBy: [{ changedAt: 'desc' }, { payslipLogId: 'desc' }],
        select: { payslipLogId: true, logType: true, changedAt: true },
      });
    });

    it('목록 줄은 항목 없이 금액 · 근무지 · 이력을 담는다', async () => {
      await expect(service.list(3, NOW)).resolves.toEqual({ items: [shown] });
    });

    it('명세서가 없으면 점포를 묻지 않고 빈 목록', async () => {
      prisma.payslip.findMany.mockResolvedValue([]);
      await expect(service.list(3, NOW)).resolves.toEqual({ items: [] });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });

    it('점포를 찾지 못하면 500', async () => {
      prisma.store.findMany.mockResolvedValue([]);
      await expect(service.list(3, NOW)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('findOne', () => {
    it('목록과 같은 조건 안에서 찾는다 — 남의 것 · 발송 전 · 3년 지난 것은 null', async () => {
      prisma.payslip.findFirst.mockResolvedValue(null);
      await expect(service.findOne(3, 40, NOW)).resolves.toBeNull();
      expect(firstArg(prisma.payslip.findFirst).where).toEqual({
        payslipId: 40,
        ...MINE,
      });
    });

    it('항목은 급여 항목 순서로, 항목 코드를 붙여 담는다', async () => {
      await expect(service.findOne(3, 40, NOW)).resolves.toEqual({
        ...shown,
        isWithholdingApplied: true,
        items: [
          {
            payslipItemId: 1,
            itemCategory: 'EARNING',
            itemCode: 'BASE_PAY',
            itemName: '기본급',
            isTaxFree: false,
            calculatedAmount: 1_000_000,
            adjustedAmount: null,
            isEntered: true,
          },
        ],
      });
      const select = firstArg(prisma.payslip.findFirst).select as Record<
        string,
        { orderBy?: unknown }
      >;
      expect(select.payslipItems.orderBy).toEqual([
        { payslipItemMaster: { sortOrder: 'asc' } },
        { payslipItemId: 'asc' },
      ]);
    });
  });
});
