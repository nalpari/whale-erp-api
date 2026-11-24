import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceRecordsService } from './attendance-records.service';
import { payInputOf } from '../payslips/payslip-calculation';
import type { PayInput } from '../payslips/pay-calculation';

jest.mock('../payslips/payslip-calculation', () => ({
  payInputOf: jest.fn(),
}));
jest.mock('../payslips/payslip-attendance-reasons', () => ({
  periodContractIds: jest.fn().mockResolvedValue([]),
}));

// 일별 · 기간 · 열린 출근이 모두 거치는 점포 범위(scopeOf)만 본다 — 공개 메서드는 출퇴근 계산까지 엮여 있어,
// 점포 유형(storeTypes)이 어느 점포를 남기는지는 범위 계산 하나로 확인한다.
describe('AttendanceRecordsService — 점포 범위(storeTypes, 본사 점포)', () => {
  let service: AttendanceRecordsService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: { store: { findMany: jest.Mock } };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT', isHq: false },
          { storeId: 2, storeTypeCode: 'FRANCHISE', isHq: false },
          { storeId: 3, storeTypeCode: 'DIRECT', isHq: true },
        ],
      }),
    };
    prisma = {
      store: {
        findMany: jest.fn(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(
              where.storeId.in.map((storeId) => ({
                storeId,
                name: `점포${storeId}`,
              })),
            ),
        ),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        AttendanceRecordsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(AttendanceRecordsService);
  });

  /** private scopeOf 를 부른다 — 위 주석의 이유로 범위 계산만 떼어 본다. */
  const storeIdsOf = async (storeTypes?: string[]) => {
    const result = await (
      service as unknown as {
        scopeOf: (
          id: number,
          q: { storeTypes?: string[] },
        ) => Promise<{ storeIds: number[] }>;
      }
    ).scopeOf(9, storeTypes ? { storeTypes } : {});
    return result.storeIds;
  };

  it('HQ 는 본사 점포만 — 폐점을 빼고 묻는다', async () => {
    await expect(storeIdsOf(['HQ'])).resolves.toEqual([3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [3] }, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true, name: true, isHq: true },
    });
  });

  it('DIRECT 는 본사가 아닌 직영만', async () => {
    await expect(storeIdsOf(['DIRECT'])).resolves.toEqual([1]);
  });

  it('유형이 없으면 본사 포함 전부 — 폐점 조건 없이 묻는다', async () => {
    await expect(storeIdsOf()).resolves.toEqual([1, 2, 3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [1, 2, 3] } },
      select: { storeId: true, name: true, isHq: true },
    });
  });
});

// 직원 앱 기간별의 주별 줄(WHALEERP-768) — 급여 계산 입력(payInputOf)만 갈아 끼우고, 주별 줄이 조회 기간 안의 날만 세는지 본다.
describe('AttendanceRecordsService.mine — 주별 줄(weeks)', () => {
  let service: AttendanceRecordsService;

  beforeEach(async () => {
    const prisma = {
      staffMember: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ storeId: 1, employmentType: 'FULL_TIME' }),
      },
      store: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ name: '강남점', isHq: false }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        AttendanceRecordsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: {} },
      ],
    }).compile();
    service = module.get(AttendanceRecordsService);
    // 하루 줄 · 이력은 이 테스트의 관심이 아니다
    const internals = service as unknown as Record<string, unknown>;
    internals.rows = jest.fn().mockResolvedValue({ rows: [] });
    internals.withEdits = jest.fn().mockResolvedValue([]);
  });

  /** 계약 없는 정직원 — 근무 분만 센다(주휴 조건을 못 채워 걸친 주는 다음 몫이 맡는다) */
  const inputWith = (worked: Record<string, number>): PayInput => ({
    employmentType: 'FULL_TIME',
    contracts: [],
    hiredDate: null,
    retiredDate: null,
    periodStart: '2026-10-26',
    periodEnd: '2026-12-06',
    worked,
    isPremiumApplied: true,
  });

  it('11/1~11/30 — 첫 주 「10/26 – 11/1」은 11/1 만, 마지막 주는 11/30 만, 꽉 찬 주는 그대로', async () => {
    jest.mocked(payInputOf).mockResolvedValue(
      inputWith({
        // 기간 밖 10월 근무 20시간
        '2026-10-26': 240,
        '2026-10-27': 240,
        '2026-10-28': 240,
        '2026-10-29': 240,
        '2026-10-30': 240,
        '2026-11-01': 60,
        // 꽉 찬 주 — 하루 9시간 5일(하루 연장 1시간씩) + 토 7시간 = 주 40시간 넘긴 연장도
        '2026-11-02': 540,
        '2026-11-03': 540,
        '2026-11-04': 540,
        '2026-11-05': 540,
        '2026-11-06': 540,
        '2026-11-07': 420,
        '2026-11-30': 300,
        // 기간 밖 12월 근무
        '2026-12-01': 480,
      }),
    );
    const res = await service.mine(7, 3, '2026-11-01', '2026-11-30');
    expect(res.weeks).toEqual([
      { monday: '2026-10-26', workedMinutes: 60, overtimeMinutes: 0 },
      { monday: '2026-11-02', workedMinutes: 3_120, overtimeMinutes: 720 },
      { monday: '2026-11-09', workedMinutes: 0, overtimeMinutes: 0 },
      { monday: '2026-11-16', workedMinutes: 0, overtimeMinutes: 0 },
      { monday: '2026-11-23', workedMinutes: 0, overtimeMinutes: 0 },
      { monday: '2026-11-30', workedMinutes: 300, overtimeMinutes: 0 },
    ]);
    // 주별 합 = 기간 합(연장도 같은 기준)
    const sum = (k: 'workedMinutes' | 'overtimeMinutes') =>
      res.weeks.reduce((s, w) => s + w[k], 0);
    expect(res.totals).toEqual({
      workedMinutes: sum('workedMinutes'),
      overtimeMinutes: sum('overtimeMinutes'),
    });
  });
});
