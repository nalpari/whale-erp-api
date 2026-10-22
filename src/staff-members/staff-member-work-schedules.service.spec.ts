import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { READ_DENIED_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import {
  periodRange,
  StaffMemberWorkSchedulesService,
} from './staff-member-work-schedules.service';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

// 2026-10-21(수) 한국 시각 오전 8시 30분 — UTC 로는 전날(화) 밤이라 한국 날짜로 정하는지 함께 본다
const NOW = new Date('2026-10-20T23:30:00Z');
/** 그 한국 날짜의 0시(KST) */
const kst0 = (ymd: string) => new Date(`${ymd}T00:00:00+09:00`);

describe('periodRange — 기간의 시작 · 끝(근무 시작 일시와 견준다)', () => {
  it('THIS_WEEK — 한국 날짜 기준 이번 주 월요일 0시 ~ 다음 주 월요일 0시 전', () => {
    expect(periodRange('THIS_WEEK', NOW)).toEqual({
      gte: kst0('2026-10-19'),
      lt: kst0('2026-10-26'),
    });
  });

  it('THIS_WEEK — 일요일이면 그 주 월요일부터(다음 주가 아니다)', () => {
    // 2026-10-25(일) 23시 KST
    expect(periodRange('THIS_WEEK', new Date('2026-10-25T14:00:00Z'))).toEqual({
      gte: kst0('2026-10-19'),
      lt: kst0('2026-10-26'),
    });
  });

  it('LAST_4_WEEKS — 오늘에서 28일 전 0시부터, 상한 없음(미래 근무 포함)', () => {
    expect(periodRange('LAST_4_WEEKS', NOW)).toEqual({
      gte: kst0('2026-09-23'),
    });
  });

  it('LAST_3_MONTHS — 오늘에서 3개월 전 같은 날 0시부터, 상한 없음', () => {
    expect(periodRange('LAST_3_MONTHS', NOW)).toEqual({
      gte: kst0('2026-07-21'),
    });
  });

  it('LAST_3_MONTHS — 그 달에 같은 날이 없으면 마지막 날(5월 31일 → 2월 28일)', () => {
    expect(
      periodRange('LAST_3_MONTHS', new Date('2026-05-31T03:00:00Z')),
    ).toEqual({ gte: kst0('2026-02-28') });
  });

  it('LAST_1_YEAR — 오늘에서 12개월 전 같은 날 0시부터, 상한 없음', () => {
    expect(periodRange('LAST_1_YEAR', NOW)).toEqual({
      gte: kst0('2025-10-21'),
    });
  });

  it('ALL — 날짜 조건 없음', () => {
    expect(periodRange('ALL', NOW)).toEqual({});
  });

  it('목록 밖 값은 이번 주 등으로 바꿔 답하지 않고 400 — 컨트롤러 검증을 거치지 않고 서비스를 부른 경우', () => {
    expect(() => periodRange('THIS_MONTH' as 'ALL', NOW)).toThrow(
      BadRequestException,
    );
  });
});

describe('StaffMemberWorkSchedulesService', () => {
  let service: StaffMemberWorkSchedulesService;
  let scope: { canManageStaffMember: jest.Mock };
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    menu: { count: jest.Mock };
    store: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  let pageRows: unknown[];
  let aggregate: { total: number; minutes: number };

  beforeEach(async () => {
    pageRows = [];
    aggregate = { total: 0, minutes: 0 };
    scope = { canManageStaffMember: jest.fn().mockResolvedValue(true) };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      menu: { count: jest.fn().mockResolvedValue(1) },
      store: { findMany: jest.fn().mockResolvedValue([]) },
      // 첫 호출은 페이지 행, 둘째는 기간 전체 집계(건수 · 근무시간 합계)
      $queryRaw: jest.fn((sql: Prisma.Sql) =>
        Promise.resolve(
          sql.text.includes('COUNT(*)')
            ? [{ total: aggregate.total, totalWorkMinutes: aggregate.minutes }]
            : pageRows,
        ),
      ),
      $transaction: jest.fn((ps: Promise<unknown>[]) => Promise.all(ps)),
    };
    const module = await Test.createTestingModule({
      providers: [
        StaffMemberWorkSchedulesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(StaffMemberWorkSchedulesService);
  });

  const firstArg = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [Record<string, any>])[0];
  const sqlOf = (n: number) =>
    (prisma.$queryRaw.mock.calls[n] as [Prisma.Sql])[0];
  /** 페이지 SQL · 집계 SQL */
  const rawSql = () => sqlOf(0);
  const aggSql = () => sqlOf(1);

  it('근무스케줄 관리(/work-schedules) 조회 권한이 없으면 「조회 권한이 없습니다.」 403 — 범위보다 먼저 본다', async () => {
    prisma.roleGroupMenu.count.mockResolvedValue(0);
    await expect(service.list(9, 30, {}, NOW)).rejects.toThrow(
      new ForbiddenException(READ_DENIED_MESSAGE),
    );
    expect(firstArg(prisma.roleGroupMenu.count).where).toMatchObject({
      menu: { url: '/work-schedules' },
    });
    expect(scope.canManageStaffMember).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('없는 직원 · 범위 밖 · 가려지는 직원은 404 이고 근무스케줄을 읽지 않는다', async () => {
    scope.canManageStaffMember.mockResolvedValue(false);
    await expect(service.list(9, 30, {}, NOW)).rejects.toThrow(
      new NotFoundException(STAFF_NOT_FOUND_MESSAGE),
    );
    expect(scope.canManageStaffMember).toHaveBeenCalledWith(9, 30);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('기본은 이번 주 · 1쪽 · 20건 — 집계는 페이지와 같은 조건(이 직원 · 지우지 않은 것 · 기간), LIMIT 없이', async () => {
    await service.list(9, 30, {}, NOW);
    const sql = rawSql();
    expect(sql.values).toEqual([
      30,
      kst0('2026-10-19'),
      kst0('2026-10-26'),
      20,
      0,
    ]);
    expect(sql.text).toMatch(/staff_member_id = \$1/);
    expect(sql.text).toMatch(/NOT is_deleted/);
    expect(sql.text).toMatch(/start_at >= \$2/);
    expect(sql.text).toMatch(/start_at < \$3/);
    const agg = aggSql();
    expect(agg.values).toEqual([30, kst0('2026-10-19'), kst0('2026-10-26')]);
    const where = (t: string) =>
      /WHERE (.*?)(ORDER|LIMIT|$)/s.exec(t)?.[1].trim();
    expect(where(agg.text)).toBe(where(sql.text));
    expect(agg.text).not.toMatch(/LIMIT/);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('근무시간 합계는 요약의 workMinutes 와 같은 식 — 종료 − 시작(분) − 휴게, 0건이면 0', async () => {
    await expect(service.list(9, 30, {}, NOW)).resolves.toEqual({
      items: [],
      total: 0,
      totalWorkMinutes: 0,
    });
    expect(aggSql().text.replace(/\s+/g, ' ')).toContain(
      'COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60 - break_minutes), 0)',
    );
  });

  it('근무시간 합계는 기간 전체다 — 페이지에 든 행만이 아니다', async () => {
    aggregate = { total: 23, minutes: 2760 };
    await expect(
      service.list(9, 30, { period: 'ALL', page: 9 }, NOW),
    ).resolves.toEqual({ items: [], total: 23, totalWorkMinutes: 2760 });
  });

  it('정렬은 근무일(한국 날짜) 내림차순 → 시작 시각 오름차순 → ID', async () => {
    await service.list(9, 30, {}, NOW);
    expect(rawSql().text.replace(/\s+/g, ' ')).toContain(
      "ORDER BY (start_at AT TIME ZONE 'Asia/Seoul')::date DESC, start_at ASC, work_schedule_id ASC",
    );
  });

  it('ALL 은 날짜 조건 없이 — page · pageSize 로 LIMIT · OFFSET', async () => {
    await service.list(9, 30, { period: 'ALL', page: 3, pageSize: 50 }, NOW);
    const sql = rawSql();
    expect(sql.values).toEqual([30, 50, 100]);
    expect(sql.text).not.toMatch(/start_at >=/);
    expect(aggSql().values).toEqual([30]);
  });

  it('LAST_4_WEEKS 는 시작만 있고 상한이 없다', async () => {
    await service.list(9, 30, { period: 'LAST_4_WEEKS' }, NOW);
    expect(aggSql().values).toEqual([30, kst0('2026-09-23')]);
    const sql = rawSql();
    expect(sql.values).toEqual([30, kst0('2026-09-23'), 20, 0]);
    expect(sql.text).not.toMatch(/start_at </);
  });

  it('항목은 근무일 · 근무지 이름 · 시작 · 종료(HH:mm 한국 시각) — 자정을 넘는 근무는 시작한 날', async () => {
    pageRows = [
      {
        workScheduleId: 7,
        storeId: 5,
        startAt: new Date('2026-10-25T13:00:00Z'), // 10-25(일) 22:00 KST
        endAt: new Date('2026-10-25T17:00:00Z'), // 10-26 02:00 KST
      },
      {
        workScheduleId: 8,
        storeId: 6,
        startAt: new Date('2026-10-19T00:00:00Z'), // 10-19 09:00 KST
        endAt: new Date('2026-10-19T08:00:00Z'),
      },
    ];
    aggregate = { total: 2, minutes: 720 };
    prisma.store.findMany.mockResolvedValue([
      { storeId: 5, name: '강남점' },
      { storeId: 6, name: '역삼점' },
    ]);
    await expect(service.list(9, 30, {}, NOW)).resolves.toEqual({
      items: [
        {
          workScheduleId: 7,
          workDate: '2026-10-25',
          storeName: '강남점',
          startTime: '22:00',
          endTime: '02:00',
        },
        {
          workScheduleId: 8,
          workDate: '2026-10-19',
          storeName: '역삼점',
          startTime: '09:00',
          endTime: '17:00',
        },
      ],
      total: 2,
      totalWorkMinutes: 720,
    });
    expect(firstArg(prisma.store.findMany).where).toEqual({
      storeId: { in: [5, 6] },
    });
  });

  it('비면 점포를 묻지 않고 { items: [], total }', async () => {
    aggregate = { total: 4, minutes: 960 };
    await expect(service.list(9, 30, { page: 99 }, NOW)).resolves.toEqual({
      items: [],
      total: 4,
      totalWorkMinutes: 960,
    });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });

  it('점포를 못 찾으면 빈 칸으로 내보내지 않고 500 — 근무스케줄 · 점포 · 직원 ID 를 오류 로그로 남긴다', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    pageRows = [
      {
        workScheduleId: 7,
        storeId: 5,
        startAt: new Date('2026-10-19T00:00:00Z'),
        endAt: new Date('2026-10-19T08:00:00Z'),
      },
    ];
    await expect(service.list(9, 30, {}, NOW)).rejects.toThrow(
      new InternalServerErrorException(
        '근무스케줄 7 의 점포 5 를 찾을 수 없습니다',
      ),
    );
    expect(error).toHaveBeenCalledTimes(1);
    const [message] = error.mock.calls[0] as [string];
    expect(message).toEqual(expect.stringContaining('근무스케줄 7'));
    expect(message).toEqual(expect.stringContaining('점포 5'));
    expect(message).toEqual(expect.stringContaining('직원 30'));
    error.mockRestore();
  });
});
