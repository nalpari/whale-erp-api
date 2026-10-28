import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { PayslipListService } from './payslip-list.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const row = (over: object = {}) => ({
  payslipId: 40,
  storeId: 5,
  periodStartDate: d('2026-09-01'),
  periodEndDate: d('2026-09-30'),
  employmentType: 'PART_TIME',
  status: 'SENT',
  staffMember: { name: '서지안', account: { isHqSharingConsented: false } },
  payslipReviewReasons: [],
  isWithholdingApplied: false,
  payslipItems: [],
  payslipDispatches: [{ sentAt: new Date('2026-10-10T01:00:00.000Z') }],
  ...over,
});

const detailRow = (over: object = {}) => ({
  payslipId: 40,
  staffMemberId: 30,
  storeId: 5,
  contractId: 7,
  periodStartDate: d('2026-09-01'),
  periodEndDate: d('2026-09-30'),
  employmentType: 'PART_TIME',
  attendanceStartDate: d('2026-08-26'),
  attendanceEndDate: d('2026-09-25'),
  status: 'REVIEWING',
  isPremiumApplied: true,
  isWithholdingApplied: true,
  grossPayAmount: 1_000_000,
  totalDeductionAmount: 33_000,
  netPayAmount: 967_000,
  confirmedAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
  staffMember: { name: '서지안', account: { isHqSharingConsented: false } },
  contract: { contractId: 7, status: 'SIGNED', wageAmount: 10_320 },
  payslipItems: [
    {
      payslipItemId: 1,
      itemCategory: 'EARNING',
      payslipItemMasterId: 1,
      itemName: '기본급',
      isTaxFree: false,
      calculatedAmount: 1_000_000,
      adjustedAmount: null,
      isEntered: true,
      payslipItemMaster: { itemCode: 'BASE_PAY' },
    },
  ],
  payslipReviewReasons: [
    {
      payslipReviewReasonId: 3,
      reviewReason: 'MISSING_ATTENDANCE',
      detail: '출퇴근 기록 2일 누락',
      acknowledgedAt: null,
    },
  ],
  payslipLogs: [
    {
      payslipLogId: 9,
      logType: 'EDIT',
      fromStatus: null,
      toStatus: null,
      summary: '연장수당 96,000원 → 128,000원',
      changedBy: 77,
      changedAt: new Date('2026-10-02T00:00:00.000Z'),
    },
    {
      payslipLogId: 8,
      logType: 'DRAFT',
      fromStatus: null,
      toStatus: 'DRAFTING',
      summary: '초안 생성',
      changedBy: null,
      changedAt: new Date('2026-10-01T00:00:00.000Z'),
    },
  ],
  payslipDispatches: [],
  ...over,
});

describe('PayslipListService', () => {
  let service: PayslipListService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    payslip: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    store: { findMany: jest.Mock };
    adminAccount: { findMany: jest.Mock };
  };

  beforeEach(async () => {
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
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      payslip: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue({
          storeId: 5,
          staffMember: { account: { isHqSharingConsented: false } },
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(detailRow()),
        count: jest.fn().mockResolvedValue(1),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 서초점' },
          { storeId: 6, name: '모리커피 청담점' },
        ]),
      },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 77, name: '김관리' }]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        PayslipListService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(PayslipListService);
  });

  const firstArg = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [Record<string, unknown>])[0];
  const where = () =>
    firstArg(prisma.payslip.findMany).where as { AND: unknown[] };
  const month = '2026-09';
  const SEPTEMBER = {
    periodStartDate: { gte: d('2026-09-01'), lt: d('2026-10-01') },
  };

  describe('list', () => {
    it('사용 중인 관리자가 아니면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      await expect(service.list(9, { month })).resolves.toBeNull();
      expect(prisma.payslip.findMany).not.toHaveBeenCalled();
    });

    it('관리 점포가 없으면 쿼리 없이 빈 목록 · 건수 0', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'PM',
        stores: [],
      });
      await expect(service.list(9, { month })).resolves.toEqual({
        items: [],
        total: 0,
        statusCounts: { DRAFTING: 0, REVIEWING: 0, CONFIRMED: 0, SENT: 0 },
        reviewPendingCount: 0,
      });
      expect(prisma.payslip.findMany).not.toHaveBeenCalled();
    });

    it('급여 기간(그 달에 시작하는 명세서)과 관리 범위로 거른다 — 점포를 고르지 않으면 범위 전체', async () => {
      await service.list(9, { month });
      expect(where().AND).toContainEqual(SEPTEMBER);
      expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    });

    it('12월은 다음 해 1월 1일 전까지다', async () => {
      await service.list(9, { month: '2026-12' });
      expect(where().AND).toContainEqual({
        periodStartDate: { gte: d('2026-12-01'), lt: d('2027-01-01') },
      });
    });

    it('명세서 상태로 거른다', async () => {
      await service.list(9, { month, status: ['REVIEWING', 'CONFIRMED'] });
      expect(where().AND).toContainEqual({
        status: { in: ['REVIEWING', 'CONFIRMED'] },
      });
    });

    it('상태 필터가 있으면 BM · BA 에게 가맹 점포의 동의 안 한 직원 명세서를 뺀다 — 가린 줄의 상태가 드러나지 않게', async () => {
      await service.list(9, { month, status: ['SENT'] });
      expect(where().AND).toContainEqual({
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            staffMember: {
              account: { is: { isHqSharingConsented: true } },
            },
          },
        ],
      });
    });

    it('네 상태를 모두 고르면 필터가 없는 것과 같아 가린 줄을 빼지 않는다', async () => {
      await service.list(9, {
        month,
        status: ['DRAFTING', 'REVIEWING', 'CONFIRMED', 'SENT'],
      });
      expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    });

    it('가맹 관리자(FM)는 상태로 걸러도 점포 전체를 본다', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      await service.list(9, { month, status: ['SENT'] });
      expect(where().AND).toContainEqual({ storeId: { in: [6] } });
    });

    it('페이지 · 정렬 · count 가 같은 where 를 쓴다. 기본은 20건', async () => {
      await service.list(9, { month, page: 3, pageSize: 50 });
      const args = firstArg(prisma.payslip.findMany);
      expect(args.skip).toBe(100);
      expect(args.take).toBe(50);
      expect(args.orderBy).toEqual([
        { staffMember: { name: 'asc' } },
        { payslipId: 'asc' },
      ]);
      expect(prisma.payslip.count).toHaveBeenCalledWith({ where: args.where });

      prisma.payslip.findMany.mockClear();
      await service.list(9, { month });
      expect(firstArg(prisma.payslip.findMany).skip).toBe(0);
      expect(firstArg(prisma.payslip.findMany).take).toBe(20);
    });

    it('상태 건수는 상태 필터와 상관없이 그 달 · 관리 범위 전체로 센다 — 가린 줄도 센다', async () => {
      prisma.payslip.groupBy.mockResolvedValue([
        { status: 'REVIEWING', _count: { _all: 2 } },
        { status: 'SENT', _count: { _all: 5 } },
      ]);
      const result = await service.list(9, { month, status: ['SENT'] });
      expect(prisma.payslip.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { storeId: { in: [5, 6] }, ...SEPTEMBER },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      });
      expect(result!.statusCounts).toEqual({
        DRAFTING: 0,
        REVIEWING: 2,
        CONFIRMED: 0,
        SENT: 5,
      });
    });

    it('점포 유형(상단 점포 범위)으로 거른다 — 폐점 점포는 뺀다', async () => {
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 6 }]);
      await service.list(9, { month, storeTypes: ['FRANCHISE'] });
      expect(prisma.store.findMany).toHaveBeenNthCalledWith(1, {
        where: { storeId: { in: [6] }, storeStatusCode: { not: 'CLOSED' } },
        select: { storeId: true },
      });
      expect(where().AND).toContainEqual({ storeId: { in: [6] } });

      prisma.store.findMany.mockResolvedValueOnce([]);
      prisma.payslip.findMany.mockClear();
      await expect(
        service.list(9, { month, storeTypes: ['FRANCHISE'] }),
      ).resolves.toMatchObject({ items: [], total: 0 });
      expect(prisma.payslip.findMany).not.toHaveBeenCalled();
    });

    it('점포로 거른다 — 관리 범위 밖의 점포 ID 는 조용히 빠지고, 남는 게 없으면 쿼리 없이 0건', async () => {
      await service.list(9, { month, storeIds: [6, 99] });
      expect(where().AND).toContainEqual({ storeId: { in: [6] } });
      expect(prisma.payslip.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: { in: [6] }, ...SEPTEMBER },
        }),
      );

      prisma.payslip.findMany.mockClear();
      await expect(service.list(9, { month, storeIds: [99] })).resolves.toEqual(
        {
          items: [],
          total: 0,
          statusCounts: { DRAFTING: 0, REVIEWING: 0, CONFIRMED: 0, SENT: 0 },
          reviewPendingCount: 0,
        },
      );
      expect(prisma.payslip.findMany).not.toHaveBeenCalled();
    });

    it('직원명 부분 일치(LIKE 와일드카드는 글자 그대로)로 거르고, BM · BA 에게 가린 줄은 뺀다 — 이름 검색이 가린 직원을 드러내지 않게', async () => {
      await service.list(9, { month, staffName: '서_지' });
      const masked = {
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            staffMember: {
              account: { is: { isHqSharingConsented: true } },
            },
          },
        ],
      };
      const name = {
        staffMember: { name: { contains: '서\\_지', mode: 'insensitive' } },
      };
      expect(where().AND).toContainEqual(masked);
      expect(where().AND).toContainEqual(name);
      // 상태 건수도 같은 이름 · 가림 조건으로 센다 — 건수로 가린 직원의 명세서가 있는지 드러나지 않게
      expect(prisma.payslip.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [masked, SEPTEMBER, name] } }),
      );
    });

    it('가맹 관리자(FM)는 이름으로 걸러도 점포 전체에서 찾는다', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      await service.list(9, { month, staffName: '서지안' });
      expect(where().AND).toContainEqual({ storeId: { in: [6] } });
    });

    it('목록 줄: 급여 기간 · 직원명 · 근무지 · 계약 유형 · 출퇴근 확인 여부 · 상태 · 발송일', async () => {
      const result = await service.list(9, { month });
      expect(result!.items).toEqual([
        {
          payslipId: 40,
          isMasked: false,
          staffName: '서지안',
          storeId: 5,
          storeName: '모리커피 서초점',
          periodStartDate: '2026-09-01',
          periodEndDate: '2026-09-30',
          employmentType: 'PART_TIME',
          isAttendanceConfirmed: true,
          status: 'SENT',
          lastSentAt: new Date('2026-10-10T01:00:00.000Z'),
          pendingReviewReasons: [],
        },
      ]);
      expect(result!.total).toBe(1);
    });

    it('발송일은 성공한 발송 중 가장 늦은 것 하나만 읽는다', async () => {
      await service.list(9, { month });
      const select = firstArg(prisma.payslip.findMany).select as Record<
        string,
        unknown
      >;
      expect(select.payslipDispatches).toEqual({
        where: { status: 'SUCCEEDED' },
        orderBy: [{ sentAt: 'desc' }, { payslipDispatchId: 'desc' }],
        take: 1,
        select: { sentAt: true },
      });
    });

    it.each([
      [[], true],
      [[{ reviewReason: 'CONTRACT_CHANGED' }], true],
      [[{ reviewReason: 'MISSING_ATTENDANCE' }], false],
    ])('확인 안 한 사유 %j → 출퇴근 확인 %s', async (reasons, confirmed) => {
      prisma.payslip.findMany.mockResolvedValue([
        row({ payslipReviewReasons: reasons, payslipDispatches: [] }),
      ]);
      const result = await service.list(9, { month });
      expect(result!.items[0].isAttendanceConfirmed).toBe(confirmed);
      expect(result!.items[0].lastSentAt).toBeNull();
    });

    it('줄마다 확인하지 않은 검토 사유를 정해진 순서로 한 번씩 — 확인 안 한 사유만 읽는다(WHALEERP-234)', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row({
          status: 'DRAFTING',
          payslipReviewReasons: [
            { reviewReason: 'ATTENDANCE_NEEDS_REVIEW' },
            { reviewReason: 'MISSING_ATTENDANCE' },
            { reviewReason: 'ATTENDANCE_NEEDS_REVIEW' },
            { reviewReason: 'DEDUCTION_MISSING' },
          ],
        }),
      ]);
      const result = await service.list(9, { month });
      expect(result!.items[0].pendingReviewReasons).toEqual([
        'MISSING_ATTENDANCE',
        'ATTENDANCE_NEEDS_REVIEW',
      ]);
      const select = firstArg(prisma.payslip.findMany).select as Record<
        string,
        unknown
      >;
      expect(select.payslipReviewReasons).toEqual({
        where: { acknowledgedAt: null },
        select: { reviewReason: true },
      });
    });

    it.each([
      // [3.3% 적용, 넣지 않은 공제 줄, 공제 미입력]
      [false, [{ itemCategory: 'BASIC', code: 'INCOME_TAX' }], true],
      [false, [{ itemCategory: 'ADDITIONAL', code: 'ADVANCE' }], true],
      [false, [{ itemCategory: 'WITHHOLDING', code: 'BUSINESS_TAX' }], false],
      [true, [{ itemCategory: 'BASIC', code: 'INCOME_TAX' }], false],
      [true, [{ itemCategory: 'BASIC', code: 'NATIONAL_PENSION' }], true],
      [true, [{ itemCategory: 'WITHHOLDING', code: 'BUSINESS_TAX' }], true],
      [false, [], false],
    ])(
      '공제 미입력은 공제 칸으로 판정한다 — 3.3% %s · 빈 줄 %j → %s(운영 정책 v221 PAY-06)',
      async (withholding, empty, missing) => {
        prisma.payslip.findMany.mockResolvedValue([
          row({
            status: 'REVIEWING',
            isWithholdingApplied: withholding,
            payslipReviewReasons: [{ reviewReason: 'CONTRACT_CHANGED' }],
            payslipItems: empty.map((l) => ({
              itemCategory: l.itemCategory,
              payslipItemMaster: { itemCode: l.code },
            })),
          }),
        ]);
        const result = await service.list(9, { month });
        expect(result!.items[0].pendingReviewReasons).toEqual(
          missing
            ? ['CONTRACT_CHANGED', 'DEDUCTION_MISSING']
            : ['CONTRACT_CHANGED'],
        );
        const select = firstArg(prisma.payslip.findMany).select as Record<
          string,
          unknown
        >;
        expect(select.payslipItems).toEqual({
          where: { isEntered: false, itemCategory: { not: 'EARNING' } },
          select: {
            itemCategory: true,
            payslipItemMaster: { select: { itemCode: true } },
          },
        });
      },
    );

    it('확정 · 발송된 명세서는 공제가 비어도 검토 대기가 아니다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row({
          status: 'CONFIRMED',
          payslipItems: [
            {
              itemCategory: 'BASIC',
              payslipItemMaster: { itemCode: 'INCOME_TAX' },
            },
          ],
        }),
      ]);
      const result = await service.list(9, { month });
      expect(result!.items[0].pendingReviewReasons).toEqual([]);
    });

    it('확정 · 발송된 명세서는 남은 사유가 있어도 검토 대기 배지를 달지 않는다 — 필터 · 건수와 같은 기준', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row({
          status: 'SENT',
          payslipReviewReasons: [{ reviewReason: 'AFTER_CONTRACT_END' }],
        }),
      ]);
      const result = await service.list(9, { month });
      expect(result!.items[0].pendingReviewReasons).toEqual([]);
    });

    it('검토 대기만 — 확인 안 한 사유 넷 중 하나가 남았거나 보이는 공제가 빈 명세서, BM · BA 에게 가린 줄은 뺀다 · 건수도 가린 줄을 뺀다', async () => {
      prisma.payslip.count.mockResolvedValueOnce(1).mockResolvedValueOnce(8);
      const result = await service.list(9, { month, reviewPending: true });
      const pending = {
        status: { in: ['DRAFTING', 'REVIEWING'] },
        OR: [
          {
            payslipReviewReasons: {
              some: {
                acknowledgedAt: null,
                reviewReason: {
                  in: [
                    'MISSING_ATTENDANCE',
                    'AFTER_CONTRACT_END',
                    'CONTRACT_CHANGED',
                    'ATTENDANCE_NEEDS_REVIEW',
                  ],
                },
              },
            },
          },
          // 공제 미입력 — 3.3% 를 끄면 기본 · 추가 공제, 켜면 소득세 · 지방소득세 대신 원천징수(운영 정책 v221 PAY-06)
          {
            OR: [
              {
                isWithholdingApplied: false,
                payslipItems: {
                  some: {
                    isEntered: false,
                    itemCategory: { in: ['BASIC', 'ADDITIONAL'] },
                  },
                },
              },
              {
                isWithholdingApplied: true,
                payslipItems: {
                  some: {
                    isEntered: false,
                    OR: [
                      { itemCategory: { in: ['ADDITIONAL', 'WITHHOLDING'] } },
                      {
                        itemCategory: 'BASIC',
                        payslipItemMaster: {
                          itemCode: {
                            notIn: ['INCOME_TAX', 'LOCAL_INCOME_TAX'],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      };
      const consentedOnly = {
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            staffMember: { account: { is: { isHqSharingConsented: true } } },
          },
        ],
      };
      expect(where().AND).toContainEqual(pending);
      expect(where().AND).toContainEqual(consentedOnly);
      // 건수도 가린 줄을 뺀다 — 목록과의 차이로 가린 직원의 검토 대기 여부가 드러나지 않게(ATT-30, 운영 정책 v218)
      expect(prisma.payslip.count).toHaveBeenLastCalledWith({
        where: { AND: [consentedOnly, SEPTEMBER, pending] },
      });
      expect(result!.reviewPendingCount).toBe(8);
    });

    it('직원명과 검토 대기만을 같이 걸면 검토 대기 건수도 그 이름으로 센다', async () => {
      await service.list(9, {
        month,
        staffName: '서지안',
        reviewPending: true,
      });
      const consentedOnly = {
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            staffMember: { account: { is: { isHqSharingConsented: true } } },
          },
        ],
      };
      const name = {
        staffMember: { name: { contains: '서지안', mode: 'insensitive' } },
      };
      expect(prisma.payslip.count).toHaveBeenLastCalledWith({
        where: {
          AND: [
            consentedOnly,
            SEPTEMBER,
            name,
            expect.objectContaining({
              status: { in: ['DRAFTING', 'REVIEWING'] },
            }),
          ],
        },
      });
    });

    it('검토 대기 false 는 거르지 않는다', async () => {
      await service.list(9, { month, reviewPending: false });
      expect(where().AND).toEqual([{ storeId: { in: [5, 6] } }, SEPTEMBER]);
    });

    it('BM · BA 에게 가맹 점포의 동의 안 한 직원 줄은 근무지 · 급여 기간만 남기고 가린다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row({ payslipId: 41, storeId: 6 }),
      ]);
      const result = await service.list(9, { month });
      expect(result!.items).toEqual([
        {
          payslipId: null,
          isMasked: true,
          staffName: null,
          storeId: 6,
          storeName: '모리커피 청담점',
          periodStartDate: '2026-09-01',
          periodEndDate: '2026-09-30',
          employmentType: null,
          isAttendanceConfirmed: null,
          status: null,
          lastSentAt: null,
          pendingReviewReasons: null,
        },
      ]);
    });

    it('동의한 가맹 점포 직원 · 직영 점포 직원 · 가맹 관리자에게는 가리지 않는다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row({
          storeId: 6,
          staffMember: {
            name: '이도윤',
            account: { isHqSharingConsented: true },
          },
        }),
      ]);
      expect((await service.list(9, { month }))!.items[0].isMasked).toBe(false);
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FM',
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      prisma.payslip.findMany.mockResolvedValue([row({ storeId: 6 })]);
      expect((await service.list(9, { month }))!.items[0].isMasked).toBe(false);
    });

    it('점포를 찾지 못하면 빈 칸으로 내보내지 않고 500', async () => {
      prisma.store.findMany.mockResolvedValue([]);
      await expect(service.list(9, { month })).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('findOne', () => {
    it('관리 범위 안에서만 찾는다', async () => {
      await service.findOne(9, 40);
      expect(prisma.payslip.findFirst).toHaveBeenCalledWith({
        where: { payslipId: 40, storeId: { in: [5, 6] } },
        select: {
          storeId: true,
          staffMember: {
            select: {
              account: { select: { isHqSharingConsented: true } },
            },
          },
        },
      });
    });

    it('사용 중인 관리자가 아니거나 없거나 범위 밖이면 null', async () => {
      scope.getManageableStores.mockResolvedValueOnce(null);
      await expect(service.findOne(9, 40)).resolves.toBeNull();
      prisma.payslip.findFirst.mockResolvedValue(null);
      await expect(service.findOne(9, 40)).resolves.toBeNull();
      expect(prisma.payslip.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('가려지는 명세서는 나머지를 읽기 전에 null — 목록과 같은 기준', async () => {
      prisma.payslip.findFirst.mockResolvedValue({
        storeId: 6,
        staffMember: { account: { isHqSharingConsented: false } },
      });
      await expect(service.findOne(9, 41)).resolves.toBeNull();
      expect(prisma.payslip.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('확인한 출퇴근 누락 사유만 남았으면 상세도 출퇴근 확인(true) — 목록과 같은 판정(확정 뒤, PR #169 리뷰)', async () => {
      prisma.payslip.findUniqueOrThrow.mockResolvedValue(
        detailRow({
          payslipReviewReasons: [
            {
              payslipReviewReasonId: 3,
              reviewReason: 'MISSING_ATTENDANCE',
              detail: '출퇴근 기록 2일 누락',
              acknowledgedAt: new Date('2026-10-05T00:00:00.000Z'),
            },
          ],
        }),
      );
      const result = await service.findOne(9, 40);
      expect(result!.isAttendanceConfirmed).toBe(true);
    });

    it('지급 · 공제 항목 · 실지급액 · 검토 대기 사유 · 처리 이력 · 발송 이력을 담는다', async () => {
      const result = await service.findOne(9, 40);
      expect(result).toEqual({
        payslipId: 40,
        staffMemberId: 30,
        staffName: '서지안',
        storeId: 5,
        storeName: '모리커피 서초점',
        contractId: 7,
        periodStartDate: '2026-09-01',
        periodEndDate: '2026-09-30',
        employmentType: 'PART_TIME',
        status: 'REVIEWING',
        isPremiumApplied: true,
        isWithholdingApplied: true,
        grossPayAmount: 1_000_000,
        totalDeductionAmount: 33_000,
        netPayAmount: 967_000,
        attendanceStartDate: '2026-08-26',
        attendanceEndDate: '2026-09-25',
        isAttendanceConfirmed: false,
        confirmedAt: null,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        contract: { contractId: 7, status: 'SIGNED', wageAmount: 10_320 },
        items: [
          {
            payslipItemId: 1,
            itemCategory: 'EARNING',
            payslipItemMasterId: 1,
            itemCode: 'BASE_PAY',
            itemName: '기본급',
            isTaxFree: false,
            calculatedAmount: 1_000_000,
            adjustedAmount: null,
            isEntered: true,
          },
        ],
        reviewReasons: [
          {
            payslipReviewReasonId: 3,
            reviewReason: 'MISSING_ATTENDANCE',
            detail: '출퇴근 기록 2일 누락',
            acknowledgedAt: null,
          },
        ],
        logs: [
          {
            payslipLogId: 9,
            logType: 'EDIT',
            fromStatus: null,
            toStatus: null,
            summary: '연장수당 96,000원 → 128,000원',
            changedBy: 77,
            changedByName: '김관리',
            changedAt: new Date('2026-10-02T00:00:00.000Z'),
          },
          {
            payslipLogId: 8,
            logType: 'DRAFT',
            fromStatus: null,
            toStatus: 'DRAFTING',
            summary: '초안 생성',
            changedBy: null,
            changedByName: null,
            changedAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        ],
        dispatches: [],
      });
    });

    it('항목은 급여 항목 순서, 이력은 최근 것이 위, 발송 이력은 보낸 순서로 읽는다', async () => {
      await service.findOne(9, 40);
      const args = firstArg(prisma.payslip.findUniqueOrThrow) as {
        where: unknown;
        select: Record<string, { orderBy?: unknown }>;
      };
      expect(args.where).toEqual({ payslipId: 40 });
      expect(args.select.payslipItems.orderBy).toEqual([
        { payslipItemMaster: { sortOrder: 'asc' } },
        { payslipItemId: 'asc' },
      ]);
      expect(args.select.payslipLogs.orderBy).toEqual([
        { changedAt: 'desc' },
        { payslipLogId: 'desc' },
      ]);
      expect(args.select.payslipDispatches.orderBy).toEqual([
        { sentAt: 'asc' },
        { payslipDispatchId: 'asc' },
      ]);
    });

    it('점포를 찾지 못하면 500', async () => {
      prisma.store.findMany.mockResolvedValue([]);
      await expect(service.findOne(9, 40)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});
