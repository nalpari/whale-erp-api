/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import type { HolidayCaller } from './bp-holiday-access';
import { BpHolidaysService } from './bp-holidays.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = d('2026-10-26');
const RIGHTS = { create: true, update: true, delete: true };

const full: HolidayCaller = {
  adminAccountId: 1,
  bpCodeId: 7,
  manageAll: true,
  storeScope: null,
  rights: RIGHTS,
};
const limited: HolidayCaller = {
  ...full,
  manageAll: false,
  storeScope: new Set([10]),
};

const store = (storeId: number, name: string) => ({
  storeId,
  storeCode: `ST0000${storeId}`,
  name,
  storeTypeCode: 'DIRECT',
  storeStatusCode: 'OPERATING',
  closedDate: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  isDeleted: false,
});

const holiday = (over: Record<string, unknown>) => ({
  bpHolidayId: 1,
  name: '휴일',
  description: null,
  isAllStores: false,
  holidayTypeCode: 'DAY',
  startDate: d('2026-10-09'),
  endDate: d('2026-10-09'),
  holidayRepeatTypeCode: null,
  repeatEndType: null,
  repeatEndDate: null,
  repeatCount: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  createdBy: 1,
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
  updatedBy: 1,
  storeMappings: [],
  excludedStores: [],
  changeHistories: [],
  ...over,
});

const mapping = (storeId: number, name: string, start = '2026-01-01') => ({
  holidayStoreMappingId: storeId,
  storeId,
  effectiveStartDate: d(start),
  effectiveEndDate: null,
  store: store(storeId, name),
});

describe('BpHolidaysService', () => {
  let service: BpHolidaysService;
  const prisma = {
    bpHoliday: { findMany: jest.fn(), findFirst: jest.fn() },
    bpCode: { findUniqueOrThrow: jest.fn() },
    publicHoliday: { findMany: jest.fn() },
    store: { findMany: jest.fn() },
    adminAccount: { findMany: jest.fn() },
    bpHolidayChangeHistory: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '㈜한강상회',
    });
    prisma.publicHoliday.findMany.mockResolvedValue([]);
    prisma.store.findMany.mockResolvedValue([]);
    prisma.adminAccount.findMany.mockResolvedValue([
      { adminAccountId: 1, name: '한강' },
    ]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        BpHolidaysService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(BpHolidaysService);
  });

  describe('list — 월 캘린더 · 목록', () => {
    it('계산한 날짜마다 한 줄, 같은 날짜는 전체 점포 휴일 먼저 · 등록 순서', async () => {
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          bpHolidayId: 3,
          name: '정기휴무',
          holidayTypeCode: 'REPEAT',
          startDate: d('2026-09-21'),
          endDate: null,
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
          storeMappings: [mapping(10, '판교점'), mapping(11, '서초점')],
        }),
        holiday({
          bpHolidayId: 5,
          name: '창립기념일',
          isAllStores: true,
          startDate: d('2026-10-12'),
          endDate: d('2026-10-12'),
        }),
      ]);
      prisma.publicHoliday.findMany.mockResolvedValue([
        { holidayDate: d('2026-10-03'), name: '개천절' },
      ]);

      const res = await service.list(full, { year: 2026, month: 10 }, today);

      expect(res.items.map((r) => [r.date, r.bpHolidayId])).toEqual([
        ['2026-10-05', 3],
        ['2026-10-12', 5],
        ['2026-10-12', 3],
        ['2026-10-19', 3],
        ['2026-10-26', 3],
      ]);
      expect(res.total).toBe(5);
      expect(res.items[0]).toMatchObject({
        isPast: true,
        target: {
          isAllStores: false,
          firstStoreName: '판교점',
          otherStoreCount: 1,
        },
        updatedByName: '한강',
      });
      expect(res.items[1].target).toMatchObject({
        isAllStores: true,
        bpTradeName: '㈜한강상회',
        excludedStoreCount: 0,
      });
      expect(res.items[4].isPast).toBe(false);
      expect(res.publicHolidays).toEqual([
        { holidayDate: '2026-10-03', name: '개천절' },
      ]);
    });

    it('일부 점포 사용자에게는 그날 맡은 점포에 적용되지 않는 날짜를 주지 않는다', async () => {
      // 10번은 10-20 부터 대상 — 그전 날짜는 11번(범위 밖)만 대상이다
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          holidayTypeCode: 'PERIOD',
          startDate: d('2026-10-19'),
          endDate: d('2026-10-21'),
          storeMappings: [
            mapping(10, '판교점', '2026-10-20'),
            mapping(11, '서초점'),
          ],
        }),
      ]);
      const res = await service.list(limited, { year: 2026, month: 10 }, today);
      expect(res.items.map((r) => r.date)).toEqual([
        '2026-10-20',
        '2026-10-21',
      ]);
      // 범위를 먼저 쿼리 조건으로 건다
      expect(prisma.bpHoliday.findMany.mock.calls[0][0].where).toMatchObject({
        bpCodeId: 7,
        isDeleted: false,
        OR: [
          { isAllStores: true },
          {
            storeMappings: {
              some: { isDeleted: false, storeId: { in: [10] } },
            },
          },
        ],
      });
    });

    it('휴일명 검색을 쿼리에 건다', async () => {
      prisma.bpHoliday.findMany.mockResolvedValue([]);
      await service.list(full, { year: 2026, month: 10, name: '정기' }, today);
      expect(prisma.bpHoliday.findMany.mock.calls[0][0].where.name).toEqual({
        contains: '정기',
        mode: 'insensitive',
      });
    });
  });

  describe('detail', () => {
    it('볼 수 없거나 지운 휴일은 404', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue(null);
      await expect(
        service.detail(limited, 9, undefined, today),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.bpHoliday.findFirst.mock.calls[0][0].where).toMatchObject({
        bpHolidayId: 9,
        isDeleted: false,
        bpCodeId: 7,
      });
    });

    it('반복이면 고른 날짜 다음 날짜 세 개 · 맡은 점포 표시 · 할 수 있는 것', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue(
        holiday({
          holidayTypeCode: 'REPEAT',
          startDate: d('2026-09-21'),
          endDate: null,
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
          storeMappings: [mapping(10, '판교점'), mapping(11, '서초점')],
        }),
      );
      const res = await service.detail(limited, 1, '2026-09-28', today);
      expect(res).toMatchObject({
        state: 'ONGOING',
        nextDates: ['2026-10-05', '2026-10-12', '2026-10-19'],
        appliedStoreCount: 2,
        actions: { canUpdate: false, canUpdateStores: true },
      });
      // 점포명순(서초점 → 판교점)
      expect(res.stores.map((s) => [s.storeId, s.isManaged])).toEqual([
        [11, false],
        [10, true],
      ]);
    });

    const period = (
      id: number,
      storeId: number,
      name: string,
      start: string,
      end: string | null,
    ) => ({
      holidayStoreMappingId: id,
      storeId,
      effectiveStartDate: d(start),
      effectiveEndDate: end ? d(end) : null,
      store: store(storeId, name),
    });

    it('대상 점포는 지우지 않은 모든 기간 — 점포명 · 시작일 · 기간 ID 순, 기간마다 종료일과 상태', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue(
        holiday({
          holidayTypeCode: 'REPEAT',
          startDate: d('2026-09-21'),
          endDate: null,
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
          // 이름순으로 읽힌 행 — 같은 점포의 두 기간이 섞여 와도 시작일 순으로 붙여 준다
          storeMappings: [
            period(7, 10, '가 판교점', '2026-10-26', null),
            period(3, 10, '가 판교점', '2026-09-21', '2026-10-10'),
            period(5, 11, '나 서초점', '2026-09-21', null),
          ],
        }),
      );
      const res = await service.detail(full, 1, undefined, today);
      expect(
        res.stores.map((s) => [
          s.periodId,
          s.storeId,
          s.effectiveStartDate,
          s.effectiveEndDate,
          s.periodState,
        ]),
      ).toEqual([
        [3, 10, '2026-09-21', '2026-10-10', 'ENDED'],
        [7, 10, '2026-10-26', null, 'ACTIVE'],
        [5, 11, '2026-09-21', null, 'ACTIVE'],
      ]);
      // 적용 점포 수는 그대로 오늘 기준
      expect(res.appliedStoreCount).toBe(2);
    });

    it('이름이 같은 두 점포의 기간은 섞이지 않고 점포 ID 로 묶인다', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue(
        holiday({
          storeMappings: [
            period(8, 12, '판교점', '2026-10-01', null),
            period(6, 10, '판교점', '2026-10-15', null),
            period(4, 10, '판교점', '2026-09-21', '2026-10-05'),
          ],
        }),
      );
      const res = await service.detail(full, 1, undefined, today);
      expect(res.stores.map((s) => [s.storeId, s.periodId])).toEqual([
        [10, 4],
        [10, 6],
        [12, 8],
      ]);
    });

    it('강제 종료된 휴일은 열린 기간도 ENDED, 시작 전 휴일은 UPCOMING — 예외 점포도 같다', async () => {
      const excluded = (id: number, storeId: number, start: string) => ({
        holidayExcludedStoreId: id,
        storeId,
        effectiveStartDate: d(start),
        effectiveEndDate: null,
        store: store(storeId, '판교점'),
      });
      prisma.bpHoliday.findFirst.mockResolvedValue(
        holiday({
          isAllStores: true,
          holidayTypeCode: 'PERIOD',
          startDate: d('2026-09-21'),
          endDate: d('2026-10-25'),
          excludedStores: [excluded(9, 10, '2026-09-21')],
        }),
      );
      const ended = await service.detail(full, 1, undefined, today);
      expect(ended.stores[0]).toMatchObject({
        periodId: 9,
        effectiveEndDate: null,
        periodState: 'ENDED',
      });

      prisma.bpHoliday.findFirst.mockResolvedValue(
        holiday({
          isAllStores: true,
          startDate: d('2026-11-02'),
          endDate: d('2026-11-02'),
          excludedStores: [excluded(9, 10, '2026-11-02')],
        }),
      );
      const upcoming = await service.detail(full, 1, undefined, today);
      expect(upcoming.stores[0].periodState).toBe('UPCOMING');
    });
  });

  describe('histories', () => {
    it('기본은 이달 1일부터 오늘까지(한국 날짜) · 지운 휴일 포함', async () => {
      prisma.bpHolidayChangeHistory.findMany.mockResolvedValue([]);
      prisma.bpHolidayChangeHistory.count.mockResolvedValue(0);
      await service.histories(full, { page: 1, pageSize: 20 }, today);
      const where =
        prisma.bpHolidayChangeHistory.findMany.mock.calls[0][0].where;
      expect(where.changedAt).toEqual({
        gte: new Date('2026-09-30T15:00:00.000Z'),
        lt: new Date('2026-10-26T15:00:00.000Z'),
      });
      expect(where.bpHoliday).toEqual({ bpCodeId: 7 });
    });

    it.each([
      // 끝만 보내면 시작은 그 달 1일 — 보내지 않은 기본값 때문에 400 이 나지 않게
      [
        { to: '2026-09-30' },
        '2026-08-31T15:00:00.000Z',
        '2026-09-30T15:00:00.000Z',
      ],
      // 시작만 보내면 끝은 오늘, 시작이 오늘 뒤면 그 날
      [
        { from: '2026-10-05' },
        '2026-10-04T15:00:00.000Z',
        '2026-10-26T15:00:00.000Z',
      ],
      [
        { from: '2026-11-01' },
        '2026-10-31T15:00:00.000Z',
        '2026-11-01T15:00:00.000Z',
      ],
    ])(
      '한쪽만 보내면 다른 쪽 기본값을 그에 맞춘다 %j',
      async (range, gte, lt) => {
        prisma.bpHolidayChangeHistory.findMany.mockResolvedValue([]);
        prisma.bpHolidayChangeHistory.count.mockResolvedValue(0);
        await service.histories(
          full,
          { ...range, page: 1, pageSize: 20 },
          today,
        );
        expect(
          prisma.bpHolidayChangeHistory.findMany.mock.calls[0][0].where
            .changedAt,
        ).toEqual({ gte: new Date(gte), lt: new Date(lt) });
      },
    );

    it('시작이 끝보다 늦으면 400', async () => {
      await expect(
        service.histories(
          full,
          { from: '2026-10-10', to: '2026-10-01', page: 1, pageSize: 20 },
          today,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('overlaps — 수정 중인 휴일', () => {
    // 10-01 부터 11-30 까지 — 진행 중이라 오늘 뒤 날짜가 남아 있다
    const dto = {
      name: '정기휴무',
      holidayTypeCode: 'PERIOD' as const,
      startDate: '2026-10-01',
      endDate: '2026-11-30',
      isAllStores: false,
      storeIds: [10],
      bpHolidayId: 3,
    };

    it('볼 수 없거나 없는 휴일 ID 면 404', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue(null);
      await expect(service.overlaps(limited, dto, today)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('진행 중인 그 휴일이면 지난 시작일을 받고, 자기 자신은 겹침에서 뺀다', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue({
        startDate: d('2026-10-01'),
      });
      prisma.store.findMany.mockResolvedValue([store(10, '판교점')]);
      prisma.bpHoliday.findMany.mockResolvedValue([]);
      await service.overlaps(full, dto, today);
      expect(prisma.bpHoliday.findMany.mock.calls[0][0].where).toMatchObject({
        bpHolidayId: { not: 3 },
      });
    });

    it('시작 전인 그 휴일이면 지난 시작일은 400', async () => {
      prisma.bpHoliday.findFirst.mockResolvedValue({
        startDate: d('2026-11-01'),
      });
      await expect(service.overlaps(full, dto, today)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('overlaps — 겹치는 휴일 확인', () => {
    it('점포마다 앞 10건만 주고 나머지는 건수로', async () => {
      prisma.store.findMany.mockResolvedValue([store(10, '판교점')]);
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          name: '매일 휴무',
          holidayTypeCode: 'REPEAT',
          startDate: d('2026-10-01'),
          endDate: null,
          holidayRepeatTypeCode: 'DAILY',
          repeatEndType: 'NONE',
          storeMappings: [mapping(10, '판교점')],
        }),
      ]);
      const res = await service.overlaps(
        full,
        {
          name: '임시',
          holidayTypeCode: 'PERIOD',
          startDate: '2026-11-01',
          endDate: '2026-11-20',
          isAllStores: false,
          storeIds: [10],
        },
        today,
      );
      expect(res.dateCount).toBe(20);
      expect(res.stores[0].dates).toHaveLength(10);
      expect(res.stores[0].moreDateCount).toBe(10);
    });

    it('전체 점포 새 휴일은 예외 점포를 빼고 본다', async () => {
      prisma.store.findMany.mockResolvedValue([
        store(10, '판교점'),
        store(11, '서초점'),
      ]);
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          startDate: d('2026-11-02'),
          endDate: d('2026-11-02'),
          storeMappings: [mapping(10, '판교점'), mapping(11, '서초점')],
        }),
      ]);
      const res = await service.overlaps(
        full,
        {
          name: '창립',
          holidayTypeCode: 'DAY',
          startDate: '2026-11-02',
          isAllStores: true,
          excludedStoreIds: [11],
        },
        today,
      );
      expect(res.stores.map((s) => s.storeId)).toEqual([10]);
    });

    it('일부 점포 사용자에게는 맡은 점포의 겹침만 준다', async () => {
      prisma.store.findMany.mockResolvedValue([
        store(10, '판교점'),
        store(11, '서초점'),
      ]);
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          name: '창립기념일',
          isAllStores: true,
          startDate: d('2026-11-02'),
          endDate: d('2026-11-02'),
        }),
      ]);
      const res = await service.overlaps(
        limited,
        {
          name: '임시',
          holidayTypeCode: 'DAY',
          startDate: '2026-11-02',
          isAllStores: false,
          storeIds: [10, 11],
        },
        today,
      );
      expect(res.stores.map((s) => s.storeId)).toEqual([10]);
    });

    it('같은 점포 · 같은 날짜의 기존 휴일을 점포별로 요약한다', async () => {
      prisma.store.findMany.mockResolvedValue([
        store(10, '판교점'),
        store(11, '서초점'),
      ]);
      prisma.bpHoliday.findMany.mockResolvedValue([
        holiday({
          bpHolidayId: 3,
          name: '정기휴무',
          holidayTypeCode: 'REPEAT',
          startDate: d('2026-09-21'),
          endDate: null,
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
          storeMappings: [mapping(10, '판교점')],
        }),
      ]);
      const res = await service.overlaps(
        full,
        {
          name: '임시',
          holidayTypeCode: 'PERIOD',
          startDate: '2026-11-01',
          endDate: '2026-11-10',
          isAllStores: false,
          storeIds: [10, 11],
        },
        today,
      );
      expect(res).toEqual({
        storeCount: 1,
        dateCount: 2,
        stores: [
          {
            storeId: 10,
            storeName: '판교점',
            dates: [
              { date: '2026-11-02', holidayNames: ['정기휴무'] },
              { date: '2026-11-09', holidayNames: ['정기휴무'] },
            ],
            moreDateCount: 0,
          },
        ],
      });
    });
  });
});
