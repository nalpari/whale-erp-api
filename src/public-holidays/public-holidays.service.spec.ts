// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PublicHolidaysService } from './public-holidays.service';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const HOLIDAYS = [
  {
    publicHolidayId: 11,
    holidayDate: day('2026-09-24'),
    name: '추석',
    note: '추석 연휴',
  },
  {
    publicHolidayId: 12,
    holidayDate: day('2026-09-25'),
    name: '추석',
    note: null,
  },
];

describe('PublicHolidaysService', () => {
  let service: PublicHolidaysService;
  let prisma: {
    $transaction: jest.Mock;
    publicHoliday: { findMany: jest.Mock };
    publicHolidaySynchronizationLog: { findFirst: jest.Mock };
  };

  /** 연도별 마지막 동기화 결과. 키가 없으면 그 해는 동기화한 적이 없다. */
  const latestByYear = (results: Record<number, 'SUCCEEDED' | 'FAILED'>) =>
    prisma.publicHolidaySynchronizationLog.findFirst.mockImplementation(
      ({ where }: { where: { year?: number; result?: string } }) => {
        if (where.result === 'SUCCEEDED')
          return Promise.resolve({
            synchronizedAt: new Date('2026-09-01T03:00:00.000Z'),
          });
        const result = where.year === undefined ? null : results[where.year];
        return Promise.resolve(result ? { result } : null);
      },
    );

  beforeEach(async () => {
    prisma = {
      // 배열 트랜잭션 — 넘긴 조회를 그대로 기다린다.
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      publicHoliday: { findMany: jest.fn().mockResolvedValue(HOLIDAYS) },
      publicHolidaySynchronizationLog: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        PublicHolidaysService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PublicHolidaysService);
  });

  it('월을 주면 그 달 1일부터 다음 달 1일 전까지를 날짜순으로 읽는다', async () => {
    await service.list({ year: 2026, month: 9 });
    expect(prisma.publicHoliday.findMany).toHaveBeenCalledWith({
      where: {
        year: 2026,
        holidayDate: { gte: day('2026-09-01'), lt: day('2026-10-01') },
      },
      orderBy: { holidayDate: 'asc' },
      select: {
        publicHolidayId: true,
        holidayDate: true,
        name: true,
        note: true,
      },
    });
  });

  it('12월은 다음 해 1월 1일 전까지다', async () => {
    await service.list({ year: 2026, month: 12 });
    const { where } = prisma.publicHoliday.findMany.mock.calls[0][0];
    expect(where.holidayDate).toEqual({
      gte: day('2026-12-01'),
      lt: day('2027-01-01'),
    });
  });

  it('월이 없으면 그 해 전체를 읽는다', async () => {
    await service.list({ year: 2051 });
    const { where } = prisma.publicHoliday.findMany.mock.calls[0][0];
    expect(where).toEqual({ year: 2051 });
  });

  it('날짜를 YYYY-MM-DD 로, 건수와 고른 연도 · 월을 함께 준다', async () => {
    const res = await service.list({ year: 2026, month: 9 });
    expect(res).toMatchObject({
      year: 2026,
      month: 9,
      total: 2,
      items: [
        {
          publicHolidayId: 11,
          holidayDate: '2026-09-24',
          name: '추석',
          note: '추석 연휴',
        },
        {
          publicHolidayId: 12,
          holidayDate: '2026-09-25',
          name: '추석',
          note: null,
        },
      ],
    });
    expect((await service.list({ year: 2026 })).month).toBeNull();
  });

  it('빈 달은 빈 목록과 0건이다', async () => {
    prisma.publicHoliday.findMany.mockResolvedValue([]);
    expect(await service.list({ year: 2026, month: 4 })).toMatchObject({
      items: [],
      total: 0,
    });
  });

  describe('동기화 상태', () => {
    // 한국 2027-01-01 00:30 = UTC 2026-12-31 15:30 — 서버가 UTC 여도 올해는 2027 이다.
    const NEW_YEAR_KST = new Date('2026-12-31T15:30:00.000Z');

    it('올해 · 다음 해는 한국 날짜로 정하고, 해마다 마지막 동기화를 본다', async () => {
      latestByYear({});
      await service.list({ year: 2026 }, NEW_YEAR_KST);
      const years = prisma.publicHolidaySynchronizationLog.findFirst.mock.calls
        .map(([args]) => args.where.year)
        .filter((y) => y !== undefined);
      expect(years.sort()).toEqual([2027, 2028]);
      expect(
        prisma.publicHolidaySynchronizationLog.findFirst,
      ).toHaveBeenCalledWith({
        where: { year: 2027 },
        orderBy: [{ synchronizedAt: 'desc' }, { synchronizationId: 'desc' }],
        select: { result: true },
      });
    });

    it('마지막 동기화가 실패한 해만 failedYears 에 담는다 — 그전 실패는 뒤의 성공이 덮는다', async () => {
      latestByYear({ 2027: 'SUCCEEDED', 2028: 'FAILED' });
      const res = await service.list({ year: 2026 }, NEW_YEAR_KST);
      expect(res.synchronization.failedYears).toEqual([2028]);
    });

    it('최종 동기화는 성공한 마지막 동기화 시각이다', async () => {
      latestByYear({});
      const res = await service.list({ year: 2026 }, NEW_YEAR_KST);
      expect(
        prisma.publicHolidaySynchronizationLog.findFirst,
      ).toHaveBeenCalledWith({
        where: { result: 'SUCCEEDED' },
        orderBy: [{ synchronizedAt: 'desc' }, { synchronizationId: 'desc' }],
        select: { synchronizedAt: true },
      });
      expect(res.synchronization).toEqual({
        lastSynchronizedAt: '2026-09-01T03:00:00.000Z',
        failedYears: [],
      });
    });

    it('동기화한 적이 없으면 최종 동기화는 null, 실패도 없다', async () => {
      const res = await service.list({ year: 2026 }, NEW_YEAR_KST);
      expect(res.synchronization).toEqual({
        lastSynchronizedAt: null,
        failedYears: [],
      });
    });
  });
});
