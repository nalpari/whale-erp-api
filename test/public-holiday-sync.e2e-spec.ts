import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PublicHoliday } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  type ApiHoliday,
  HolidayApiClient,
  HolidayApiUnavailableError,
} from '../src/public-holidays/holiday-api.client';
import { PublicHolidaySyncService } from '../src/public-holidays/public-holiday-sync.service';

// 공식 휴일 동기화(WHALEERP-543)를 실제 DB 로 확인한다 — 추가 · 수정 · 삭제와 이력이 한 트랜잭션으로 들어가는지,
// 날짜 고유 인덱스와 맞는지는 목으로는 증명되지 않는다. 공휴일 API 만 가짜로 바꾼다.
//
// 업무 연도와 겹치지 않게 테이블의 마지막 해인 2050년으로 돈다(2026-10-30 부터 2000~2050). 시작할 때 그 해를
// 규칙 계산 8건으로 갈아 두고, 끝나면 그 해 공휴일을 원래대로 되돌리고 그 해 이력을 지운다 — 일회용 DB 에서는
// 2050년 이력은 이 파일만 쓴다.
const YEAR = 2050;
const NOW = new Date('2050-02-01T00:00:00.000Z');
/** 시작 상태 — 마이그레이션이 이름을 맞춘 규칙 계산 행과 같은 꼴(공공 API 표기, 비고 없음). */
const SEED: [string, string][] = [
  ['2050-01-01', '1월1일'],
  ['2050-03-01', '삼일절'],
  ['2050-05-05', '어린이날'],
  ['2050-06-06', '현충일'],
  ['2050-08-15', '광복절'],
  ['2050-10-03', '개천절'],
  ['2050-10-09', '한글날'],
  ['2050-12-25', '기독탄신일'],
];
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const api = (locdate: string, dateName: string, seq = '1'): ApiHoliday => ({
  locdate,
  dateName,
  seq,
});

describe('공식 휴일 동기화 (e2e, DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sync: PublicHolidaySyncService;
  const client = { fetchYear: jest.fn(), isConfigured: true };
  let original: PublicHoliday[] = [];
  let seeded: PublicHoliday[] = [];

  const rowsOf = () =>
    prisma.publicHoliday.findMany({
      where: { year: YEAR },
      orderBy: { holidayDate: 'asc' },
    });
  const logsOf = () =>
    prisma.publicHolidaySynchronizationLog.findMany({
      where: { year: YEAR },
      orderBy: { synchronizationId: 'asc' },
    });

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HolidayApiClient)
      .useValue(client)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    sync = app.get(PublicHolidaySyncService);
    original = await rowsOf();
    await prisma.$transaction([
      prisma.publicHoliday.deleteMany({ where: { year: YEAR } }),
      prisma.publicHoliday.createMany({
        data: SEED.map(([date, name]) => ({
          holidayDate: d(date),
          year: YEAR,
          name,
          source: 'RULE' as const,
        })),
      }),
    ]);
    seeded = await rowsOf();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await prisma.$transaction([
        prisma.publicHoliday.deleteMany({ where: { year: YEAR } }),
        prisma.publicHoliday.createMany({
          data: original.map((r) => ({
            holidayDate: r.holidayDate,
            year: r.year,
            name: r.name,
            note: r.note,
            source: r.source,
            sourceRef: r.sourceRef,
            synchronizedAt: r.synchronizedAt,
          })),
        }),
        prisma.publicHolidaySynchronizationLog.deleteMany({
          where: { year: YEAR },
        }),
      ]);
    } finally {
      await app?.close();
    }
  });

  it('2050년 규칙 계산 8건에서 시작한다', async () => {
    expect((await rowsOf()).map((r) => [r.name, r.source])).toEqual(
      SEED.map(([, name]) => [name, 'RULE']),
    );
  });

  it('API 값으로 추가 · 수정하고 건수를 성공 이력에 남긴다 — 무효 항목이 있으면 그 해는 지우지 않는다', async () => {
    client.fetchYear.mockResolvedValueOnce([
      api('20500101', '1월1일'),
      api('20500301', '삼일절'),
      api('20500501', '노동절', '2'),
      api('20500505', '어린이날'),
      api('20500505', '부처님오신날', '2'),
      api('2050-12-25', '성탄절'),
    ]);

    await sync.syncYear(YEAR, NOW);

    const rows = await rowsOf();
    expect(
      rows.map((r) => [
        r.holidayDate.toISOString().slice(0, 10),
        r.name,
        r.note,
        r.source,
        r.sourceRef,
        r.synchronizedAt?.toISOString(),
      ]),
    ).toEqual([
      [
        '2050-01-01',
        '1월1일',
        null,
        'PUBLIC_API',
        '20500101-1',
        NOW.toISOString(),
      ],
      [
        '2050-03-01',
        '삼일절',
        null,
        'PUBLIC_API',
        '20500301-1',
        NOW.toISOString(),
      ],
      [
        '2050-05-01',
        '노동절',
        null,
        'PUBLIC_API',
        '20500501-2',
        NOW.toISOString(),
      ],
      [
        '2050-05-05',
        '어린이날 · 부처님오신날',
        null,
        'PUBLIC_API',
        '20500505-1,20500505-2',
        NOW.toISOString(),
      ],
      // 날짜 형식이 틀리게 온 성탄절이 가리키던 날을 지우지 않게, 이번에는 아무것도 지우지 않는다
      ['2050-06-06', '현충일', null, 'RULE', null, undefined],
      ['2050-08-15', '광복절', null, 'RULE', null, undefined],
      ['2050-10-03', '개천절', null, 'RULE', null, undefined],
      ['2050-10-09', '한글날', null, 'RULE', null, undefined],
      ['2050-12-25', '기독탄신일', null, 'RULE', null, undefined],
    ]);
    // 날짜를 고치지 않은 줄은 같은 행이다(지우고 다시 넣지 않는다)
    expect(rows[0].publicHolidayId).toBe(seeded[0].publicHolidayId);

    const [log] = await logsOf();
    expect(log).toMatchObject({
      result: 'SUCCEEDED',
      createdCount: 1,
      updatedCount: 3,
      deletedCount: 0,
      failedCount: 1,
      error: '2050-12-25 성탄절: 날짜 형식이 YYYYMMDD 가 아니다',
      synchronizedAt: NOW,
    });
  });

  it('무효 항목이 없으면 API 에 없는 그 해의 날을 출처와 관계없이 지운다', async () => {
    client.fetchYear.mockResolvedValueOnce([
      api('20500101', '1월1일'),
      api('20500301', '삼일절'),
      api('20500501', '노동절', '2'),
      api('20500505', '어린이날'),
      api('20500505', '부처님오신날', '2'),
    ]);

    await sync.syncYear(YEAR, NOW);

    expect(
      (await rowsOf()).map((r) => r.holidayDate.toISOString().slice(0, 10)),
    ).toEqual(['2050-01-01', '2050-03-01', '2050-05-01', '2050-05-05']);
    expect((await logsOf()).at(-1)).toMatchObject({
      result: 'SUCCEEDED',
      createdCount: 0,
      updatedCount: 0,
      // 현충일 · 광복절 · 개천절 · 한글날 · 성탄절
      deletedCount: 5,
      failedCount: 0,
    });
  });

  it('같은 결과로 다시 돌면 바꾸지 않고 동기화 시각만 새로 적는다', async () => {
    const later = new Date('2050-03-01T00:00:00.000Z');
    client.fetchYear.mockResolvedValueOnce([
      api('20500101', '1월1일'),
      api('20500301', '삼일절'),
      api('20500501', '노동절', '2'),
      api('20500505', '어린이날'),
      api('20500505', '부처님오신날', '2'),
    ]);
    const before = await rowsOf();

    await sync.syncYear(YEAR, later);

    const rows = await rowsOf();
    expect(rows.map((r) => r.publicHolidayId)).toEqual(
      before.map((r) => r.publicHolidayId),
    );
    expect(
      rows.every((r) => r.synchronizedAt?.getTime() === later.getTime()),
    ).toBe(true);
    expect((await logsOf()).at(-1)).toMatchObject({
      result: 'SUCCEEDED',
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      failedCount: 0,
      error: null,
    });
  });

  it('API 가 0건(미발표)이면 그 해 공휴일을 지우지 않는다', async () => {
    client.fetchYear.mockResolvedValueOnce([]);
    const before = await rowsOf();

    await sync.syncYear(YEAR, NOW);

    expect(await rowsOf()).toEqual(before);
    expect((await logsOf()).at(-1)).toMatchObject({
      result: 'SUCCEEDED',
      deletedCount: 0,
    });
  });

  it('API 를 받지 못하면 테이블은 그대로 두고 실패 이력을 남긴다', async () => {
    client.fetchYear.mockRejectedValueOnce(
      new HolidayApiUnavailableError('공휴일 API 응답 HTTP 500'),
    );
    const before = await rowsOf();

    await sync.syncYear(YEAR, NOW);

    expect(await rowsOf()).toEqual(before);
    expect((await logsOf()).at(-1)).toMatchObject({
      result: 'FAILED',
      error: '공휴일 API 응답 HTTP 500',
      createdCount: 0,
    });
  });

  it('두 인스턴스가 동시에 돌아도 같은 날짜가 두 줄이 되지 않는다', async () => {
    client.fetchYear.mockResolvedValue([
      api('20500101', '1월1일'),
      api('20500815', '광복절'),
    ]);
    const failedBefore = (await logsOf()).filter(
      (l) => l.result === 'FAILED',
    ).length;

    await Promise.all([sync.syncYear(YEAR, NOW), sync.syncYear(YEAR, NOW)]);
    client.fetchYear.mockReset();

    const rows = await rowsOf();
    expect(
      rows.map((r) => [r.holidayDate.toISOString().slice(0, 10), r.name]),
    ).toEqual([
      ['2050-01-01', '1월1일'],
      ['2050-08-15', '광복절'],
    ]);
    // 겹친 쪽은 락을 못 얻어 건너뛰거나, 앞 실행 뒤에 돌아 0건으로 끝난다 — 이 실행이 더한 실패는 없다.
    // 락이 없으면 둘 다 같은 날짜를 넣다가 고유 인덱스에 걸려 실패가 는다.
    expect((await logsOf()).filter((l) => l.result === 'FAILED')).toHaveLength(
      failedBefore,
    );
    expect(d('2050-08-15').getTime()).toBe(rows[1].holidayDate.getTime());
  });
});
