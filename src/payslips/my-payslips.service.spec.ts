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
        findFirst: jest.fn().mockResolvedValue(
          summary({
            isWithholdingApplied: true,
            payslipItems: [item],
            staffMember: { name: '유하람' },
          }),
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
    storeId: 5,
    storeName: '웨일카페 강남역점',
    sentAt: new Date('2026-10-12T00:00:00.000Z'),
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
    const stores = [
      { storeId: 5, name: '웨일카페 강남역점' },
      { storeId: 6, name: '웨일카페 홍대점' },
      { storeId: 7, name: '웨일베이커리 합정점' },
    ];
    const sent = (payslipLogId: number, at: string) => ({
      payslipLogId,
      logType: 'SEND',
      changedAt: new Date(at),
    });
    const ids = (r: { items: { payslipId: number }[] }) =>
      r.items.map((p) => p.payslipId);

    beforeEach(() => prisma.store.findMany.mockResolvedValue(stores));

    it('발송된 본인 명세서만, 보존 기간(3년) 안에서 — 퇴직 여부는 보지 않는다', async () => {
      await service.list(3, {}, NOW);
      expect(firstArg(prisma.payslip.findMany).where).toEqual(MINE);
    });

    it('3년 경계는 같은 시각까지 — 2월 29일은 setUTCFullYear 규칙(3월 1일)', async () => {
      await service.list(3, {}, new Date('2028-02-29T00:00:00.000Z'));
      expect(
        (firstArg(prisma.payslip.findMany).where as typeof MINE).createdAt,
      ).toEqual({ gt: new Date('2025-03-01T00:00:00.000Z') });
    });

    it('처리 이력은 발송 · 확정 취소만, 최근 것이 위', async () => {
      await service.list(3, {}, NOW);
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

    it('목록 줄은 항목 없이 금액 · 근무지 · 받은 날(가장 최근 발송) · 이력을 담는다', async () => {
      expect((await service.list(3, {}, NOW)).items).toEqual([shown]);
    });

    it('받은 날 최신순 — 다시 보낸 명세서는 다시 보낸 날로, 같으면 id 큰 것이 위, 발송 이력이 없으면 맨 아래', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        summary({
          payslipId: 1,
          payslipLogs: [sent(1, '2026-09-05T01:00:00Z')],
        }),
        summary({
          payslipId: 2,
          periodStartDate: d('2026-07-01'),
          payslipLogs: [
            sent(3, '2026-09-20T01:00:00Z'),
            sent(2, '2026-08-03T01:00:00Z'),
          ],
        }),
        summary({
          payslipId: 3,
          payslipLogs: [sent(4, '2026-09-05T01:00:00Z')],
        }),
        summary({ payslipId: 4, payslipLogs: [] }),
      ]);
      expect(ids(await service.list(3, {}, NOW))).toEqual([2, 3, 1, 4]);
    });

    it('이번 달 합계는 한국 시간 이번 달에 받은 것 모두 — 근무지 · 필터와 관계없다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        // 10월 1일 0시 30분(한국) 발송 — UTC 로는 9월 30일이지만 10월에 받았다
        summary({
          payslipId: 1,
          storeId: 5,
          netPayAmount: 844_430,
          payslipLogs: [sent(1, '2026-09-30T15:30:00Z')],
        }),
        summary({
          payslipId: 2,
          storeId: 6,
          netPayAmount: 312_000,
          payslipLogs: [sent(2, '2026-10-05T01:00:00Z')],
        }),
        summary({
          payslipId: 3,
          storeId: 6,
          netPayAmount: 100_000,
          payslipLogs: [sent(3, '2026-10-02T01:00:00Z')],
        }),
        // 9월 30일 23시(한국) — 9월에 받았다
        summary({
          payslipId: 4,
          storeId: 7,
          netPayAmount: 999_999,
          payslipLogs: [sent(4, '2026-09-30T14:00:00Z')],
        }),
      ]);
      const result = await service.list(3, { storeId: 7, year: 2025 }, NOW);
      expect(result.thisMonth).toEqual({
        month: '2026-10',
        count: 3,
        totalNetPayAmount: 1_256_430,
        storeNames: ['웨일카페 홍대점', '웨일카페 강남역점'],
      });
    });

    it('이번 달에 받은 것이 없으면 0건 · 0원', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        summary({ payslipLogs: [sent(1, '2026-09-10T01:00:00Z')] }),
      ]);
      expect((await service.list(3, {}, NOW)).thisMonth).toEqual({
        month: '2026-10',
        count: 0,
        totalNetPayAmount: 0,
        storeNames: [],
      });
    });

    it('점포 목록은 받은 적이 있는 곳 모두(필터 전), 이름순', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        summary({ payslipId: 1, storeId: 6 }),
        summary({ payslipId: 2, storeId: 7 }),
        summary({ payslipId: 3, storeId: 5 }),
        summary({ payslipId: 4, storeId: 6 }),
      ]);
      expect((await service.list(3, { storeId: 5 }, NOW)).stores).toEqual([
        { storeId: 7, storeName: '웨일베이커리 합정점' },
        { storeId: 5, storeName: '웨일카페 강남역점' },
        { storeId: 6, storeName: '웨일카페 홍대점' },
      ]);
    });

    it('점포 · 연도(급여 기간 기준)로 목록만 거른다 — 2025년 12월분을 2026년 1월에 받아도 2025년', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        summary({
          payslipId: 1,
          storeId: 5,
          periodStartDate: d('2025-12-01'),
          payslipLogs: [sent(1, '2026-01-10T01:00:00Z')],
        }),
        summary({
          payslipId: 2,
          storeId: 6,
          periodStartDate: d('2025-11-01'),
          payslipLogs: [sent(2, '2025-12-10T01:00:00Z')],
        }),
        summary({
          payslipId: 3,
          storeId: 5,
          periodStartDate: d('2026-01-01'),
          payslipLogs: [sent(3, '2026-02-10T01:00:00Z')],
        }),
      ]);
      expect(ids(await service.list(3, { year: 2025 }, NOW))).toEqual([1, 2]);
      expect(ids(await service.list(3, { storeId: 5 }, NOW))).toEqual([3, 1]);
      expect(
        ids(await service.list(3, { storeId: 5, year: 2026 }, NOW)),
      ).toEqual([3]);
      expect(ids(await service.list(3, { storeId: 9 }, NOW))).toEqual([]);
    });

    it('명세서가 없으면 점포를 묻지 않고 빈 목록', async () => {
      prisma.payslip.findMany.mockResolvedValue([]);
      await expect(service.list(3, {}, NOW)).resolves.toEqual({
        thisMonth: {
          month: '2026-10',
          count: 0,
          totalNetPayAmount: 0,
          storeNames: [],
        },
        stores: [],
        items: [],
      });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });

    it('점포를 찾지 못하면 500', async () => {
      prisma.store.findMany.mockResolvedValue([]);
      await expect(service.list(3, {}, NOW)).rejects.toBeInstanceOf(
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

  describe('document (PDF 내보내기)', () => {
    it('상세와 같은 조건 · 같은 값에 직원 이름을 더한다 — 상세 응답에는 이름을 싣지 않는다', async () => {
      const found = await service.document(3, 40, NOW);
      expect(found!.staffName).toBe('유하람');
      expect(found!.detail).toEqual(await service.findOne(3, 40, NOW));
      expect(found!.detail).not.toHaveProperty('staffMember');
      expect(firstArg(prisma.payslip.findFirst).where).toEqual({
        payslipId: 40,
        ...MINE,
      });
    });

    it('없거나 볼 수 없는 명세서면 null', async () => {
      prisma.payslip.findFirst.mockResolvedValue(null);
      await expect(service.document(3, 40, NOW)).resolves.toBeNull();
    });
  });
});
