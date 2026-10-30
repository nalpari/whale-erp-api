// expect.objectContaining 은 any 를 돌려준다 — 이력 칸 일부만 보는 검사라 그대로 둔다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HolidayApiClient,
  HolidayApiUnavailableError,
} from './holiday-api.client';
import { PublicHolidaySyncService } from './public-holiday-sync.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date('2026-10-31T19:00:00.000Z'); // 한국 2026-11-01 04:00

function setup() {
  const tx = {
    publicHoliday: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicHolidaySynchronizationLog: { create: jest.fn() },
  };
  const prisma = { publicHolidaySynchronizationLog: { create: jest.fn() } };
  const lock = {
    runExclusive: jest.fn(
      async (_name: string, work: (t: typeof tx) => Promise<number>) => ({
        ran: true,
        processed: await work(tx),
      }),
    ),
  };
  const client = { fetchYear: jest.fn() };
  return { tx, prisma, lock, client };
}

async function serviceOf(deps: ReturnType<typeof setup>) {
  const module = await Test.createTestingModule({
    providers: [
      PublicHolidaySyncService,
      { provide: PrismaService, useValue: deps.prisma },
      { provide: BatchLockService, useValue: deps.lock },
      { provide: HolidayApiClient, useValue: deps.client },
    ],
  }).compile();
  return module.get(PublicHolidaySyncService);
}

describe('PublicHolidaySyncService', () => {
  it('API 결과를 public-holiday-sync 락 안에서 반영하고 건수를 성공 이력에 남긴다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([
      { locdate: '20260101', dateName: '1월1일', seq: '1' },
      { locdate: '20260301', dateName: '삼일절', seq: '1' },
      { locdate: '20260501', dateName: '노동절', seq: '2' },
    ]);
    deps.tx.publicHoliday.findMany.mockResolvedValue([
      {
        publicHolidayId: 1,
        holidayDate: d('2026-01-01'),
        name: '신정',
        note: null,
        source: 'RULE',
        sourceRef: null,
      },
      {
        publicHolidayId: 2,
        holidayDate: d('2026-03-01'),
        name: '삼일절',
        note: null,
        source: 'PUBLIC_API',
        sourceRef: '20260301-1',
      },
      {
        publicHolidayId: 3,
        holidayDate: d('2026-04-05'),
        name: '식목일',
        note: null,
        source: 'RULE',
        sourceRef: null,
      },
    ]);
    const service = await serviceOf(deps);

    await service.syncYear(2026, NOW);

    expect(deps.lock.runExclusive).toHaveBeenCalledWith(
      'public-holiday-sync',
      expect.any(Function),
    );
    expect(deps.tx.publicHoliday.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { year: 2026 } }),
    );
    expect(deps.tx.publicHoliday.createMany).toHaveBeenCalledWith({
      data: [
        {
          holidayDate: d('2026-05-01'),
          year: 2026,
          name: '노동절',
          note: null,
          source: 'PUBLIC_API',
          sourceRef: '20260501-2',
          synchronizedAt: NOW,
        },
      ],
    });
    expect(deps.tx.publicHoliday.update).toHaveBeenCalledWith({
      where: { publicHolidayId: 1 },
      data: {
        name: '1월1일',
        note: null,
        source: 'PUBLIC_API',
        sourceRef: '20260101-1',
        synchronizedAt: NOW,
      },
    });
    expect(deps.tx.publicHoliday.updateMany).toHaveBeenCalledWith({
      where: { publicHolidayId: { in: [2] } },
      data: { synchronizedAt: NOW },
    });
    expect(deps.tx.publicHoliday.deleteMany).toHaveBeenCalledWith({
      where: { publicHolidayId: { in: [3] } },
    });
    expect(deps.tx.publicHolidaySynchronizationLog.create).toHaveBeenCalledWith(
      {
        data: {
          year: 2026,
          synchronizedAt: NOW,
          createdCount: 1,
          updatedCount: 1,
          deletedCount: 1,
          failedCount: 0,
          error: null,
          result: 'SUCCEEDED',
        },
      },
    );
    expect(
      deps.prisma.publicHolidaySynchronizationLog.create,
    ).not.toHaveBeenCalled();
  });

  it('무효 항목이 있으면 지우지 않고, 그 오류를 실패 건수 · 오류에 남긴다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([
      { locdate: '20260101', dateName: '1월1일', seq: '1' },
      { locdate: 'bad', dateName: '이상한 날', seq: '1' },
    ]);
    deps.tx.publicHoliday.findMany.mockResolvedValue([
      {
        publicHolidayId: 3,
        holidayDate: d('2026-04-05'),
        name: '식목일',
        note: null,
        source: 'RULE',
        sourceRef: null,
      },
    ]);
    const service = await serviceOf(deps);

    await service.syncYear(2026, NOW);

    expect(deps.tx.publicHoliday.createMany).toHaveBeenCalled();
    expect(deps.tx.publicHoliday.deleteMany).not.toHaveBeenCalled();
    expect(deps.tx.publicHolidaySynchronizationLog.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          createdCount: 1,
          deletedCount: 0,
          failedCount: 1,
          error: 'bad 이상한 날: 날짜 형식이 YYYYMMDD 가 아니다',
          result: 'SUCCEEDED',
        }),
      },
    );
  });

  it('바꿀 것이 없으면 쓰지 않고 성공 이력만 — 0건(미발표)도 같다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([]);
    const service = await serviceOf(deps);

    await service.syncYear(2027, NOW);

    expect(deps.tx.publicHoliday.createMany).not.toHaveBeenCalled();
    expect(deps.tx.publicHoliday.update).not.toHaveBeenCalled();
    expect(deps.tx.publicHoliday.updateMany).not.toHaveBeenCalled();
    expect(deps.tx.publicHoliday.deleteMany).not.toHaveBeenCalled();
    expect(deps.tx.publicHolidaySynchronizationLog.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          year: 2027,
          createdCount: 0,
          updatedCount: 0,
          deletedCount: 0,
          failedCount: 0,
          error: null,
          result: 'SUCCEEDED',
        }),
      },
    );
  });

  it('API 를 받지 못하면 락 · 테이블은 건드리지 않고 실패 이력만 남긴다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockRejectedValue(
      new HolidayApiUnavailableError('HOLIDAY_SERVICE_KEY 가 비어 있다'),
    );
    const service = await serviceOf(deps);

    await service.syncYear(2026, NOW);

    expect(deps.lock.runExclusive).not.toHaveBeenCalled();
    expect(
      deps.prisma.publicHolidaySynchronizationLog.create,
    ).toHaveBeenCalledWith({
      data: {
        year: 2026,
        synchronizedAt: NOW,
        error: 'HOLIDAY_SERVICE_KEY 가 비어 있다',
        result: 'FAILED',
      },
    });
  });

  it('반영 중 DB 가 실패하면 되돌려진 뒤 실패 이력을 남기고 던지지 않는다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([
      { locdate: '20260101', dateName: '1월1일', seq: '1' },
    ]);
    deps.lock.runExclusive.mockRejectedValue(new Error('connection reset'));
    const service = await serviceOf(deps);

    await expect(service.syncYear(2026, NOW)).resolves.toBeUndefined();

    expect(
      deps.prisma.publicHolidaySynchronizationLog.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        year: 2026,
        error: 'connection reset',
        result: 'FAILED',
      }),
    });
  });

  it('다른 인스턴스가 돌고 있어 락을 못 얻으면 이력을 남기지 않는다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([]);
    deps.lock.runExclusive.mockResolvedValue({ ran: false, processed: 0 });
    const service = await serviceOf(deps);

    await service.syncYear(2026, NOW);

    expect(
      deps.tx.publicHolidaySynchronizationLog.create,
    ).not.toHaveBeenCalled();
    expect(
      deps.prisma.publicHolidaySynchronizationLog.create,
    ).not.toHaveBeenCalled();
  });

  it('syncAll 은 한국 날짜의 올해와 다음 해를 차례로 — 한쪽이 실패해도 다른 해는 돈다', async () => {
    const deps = setup();
    deps.client.fetchYear
      .mockRejectedValueOnce(new HolidayApiUnavailableError('down'))
      .mockResolvedValueOnce([]);
    const service = await serviceOf(deps);

    // UTC 로는 2026-12-31 이지만 한국은 2027-01-01 이다
    await service.syncAll(new Date('2026-12-31T19:00:00.000Z'));

    expect(deps.client.fetchYear.mock.calls).toEqual([[2027], [2028]]);
    expect(
      deps.prisma.publicHolidaySynchronizationLog.create,
    ).toHaveBeenCalledTimes(1);
    expect(deps.tx.publicHolidaySynchronizationLog.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({ year: 2028, result: 'SUCCEEDED' }),
      },
    );
  });

  // 공식 휴일은 2050년까지다(2026-10-30) — CHECK 가 막는 해를 받아 실패 이력만 쌓지 않게 건너뛴다.
  it('syncAll 은 2050년을 넘는 해를 건너뛴다', async () => {
    const deps = setup();
    deps.client.fetchYear.mockResolvedValue([]);
    const service = await serviceOf(deps);

    await service.syncAll(new Date('2050-03-01T00:00:00.000Z'));

    expect(deps.client.fetchYear.mock.calls).toEqual([[2050]]);
  });

  it('실패 이력조차 쓰지 못해도(DB 다운) 다음 해는 시도한다', async () => {
    const deps = setup();
    deps.client.fetchYear
      .mockRejectedValueOnce(new HolidayApiUnavailableError('down'))
      .mockResolvedValueOnce([]);
    deps.prisma.publicHolidaySynchronizationLog.create.mockRejectedValueOnce(
      new Error('connection refused'),
    );
    const service = await serviceOf(deps);

    await expect(
      service.syncAll(new Date('2026-10-31T19:00:00.000Z')),
    ).resolves.toBeUndefined();

    expect(deps.client.fetchYear.mock.calls).toEqual([[2026], [2027]]);
    expect(deps.tx.publicHolidaySynchronizationLog.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({ year: 2027, result: 'SUCCEEDED' }),
      },
    );
  });
});
