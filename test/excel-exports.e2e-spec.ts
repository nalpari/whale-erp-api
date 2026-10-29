// expect.objectContaining · stringMatching 은 any 를 돌려준다 — 메일 인자 일부만 보는 검사라 그대로 둔다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  ForbiddenException,
  HttpException,
  INestApplication,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { BATCH_JOB } from '../src/batch/batch-job-names';
import { ExcelExportRegistry } from '../src/excel-exports/excel-export-registry';
import type {
  ExcelExportCaller,
  ExcelExportSource,
} from '../src/excel-exports/excel-export-source';
import { ExcelExportsService } from '../src/excel-exports/excel-exports.service';
import { OPTIONAL_MAIL_SERVICE } from '../src/mail/mail.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';

// 공통 엑셀(2026-10-28)을 실제 DB 로 확인한다 — 「생성 중 하나만」 부분 고유 인덱스 · 1분 제한 · 예약 생성 · 내려받기 · 2년
// 파기는 목으로 증명되지 않는다. 화면 대신 건수와 파일을 정할 수 있는 시험용 소스를 플랫폼 휴일 관리 메뉴(/public-holidays,
// 엑셀이 없는 화면)에 등록하고, S3 · 메일은 가짜로 바꾼다.
const MENU_URL = '/public-holidays';
const OTHER_MENU_URL = '/products';
// 이 앱에도 소스가 없는 화면 — 배치가 이 화면의 작업은 가져가지 않아야 한다
const UNREGISTERED_MENU_URL = '/sales';
const T0 = new Date('2099-03-02T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

class TestQuery {
  keyword?: string;
}

describe('공통 엑셀 (e2e, DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let exports: ExcelExportsService;
  let adminId: number;
  let menuId: number;
  let caller: ExcelExportCaller;
  const storage = {
    put: jest.fn().mockResolvedValue(undefined),
    downloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
  const source = {
    menuUrl: MENU_URL,
    screenName: '시험 목록',
    queryType: TestQuery,
    fileName: () => '시험목록_20990302.xlsx',
    count: jest.fn<Promise<number>, [ExcelExportCaller, TestQuery]>(),
    build: jest.fn<Promise<Buffer>, [ExcelExportCaller, TestQuery]>(),
    assertRequester: jest.fn<Promise<void>, [number]>(),
    // 볼 수 있는 범위의 지문 — 만들 때 남기고 받을 때 견준다
    scopeKey: jest
      .fn<Promise<string>, [ExcelExportCaller]>()
      .mockResolvedValue('scope-A'),
  } satisfies ExcelExportSource<TestQuery>;
  // 두 번째 시험 화면 — 같은 사람의 대기 작업을 하나 더 두려면 다른 메뉴가 필요하다(생성 중 하나만은 화면마다).
  // 다른 e2e 스위트의 앱에는 이 두 소스가 없어 그 앱의 크론이 이 작업들을 가져가지 않는다.
  const otherSource = {
    ...source,
    menuUrl: OTHER_MENU_URL,
    screenName: '시험 목록 2',
    build: jest.fn<Promise<Buffer>, [ExcelExportCaller, TestQuery]>(),
  } satisfies ExcelExportSource<TestQuery>;

  const logs = () =>
    prisma.excelDownloadLog.findMany({
      where: { requestedBy: adminId, menuId },
      orderBy: { excelDownloadId: 'asc' },
    });
  const clearLogs = () =>
    prisma.excelDownloadLog.deleteMany({
      where: { requestedBy: adminId, menuId },
    });
  const statusOf = async (fn: () => Promise<unknown>) =>
    fn().then(
      () => 0,
      (e: unknown) => (e instanceof HttpException ? e.getStatus() : -1),
    );

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    process.env.ADMIN_WEB_URL ??= 'https://admin.example.com';
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .overrideProvider(OPTIONAL_MAIL_SERVICE)
      .useValue(mail)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    // 진짜 크론(매 분 · 매일)을 세운다 — 테스트가 processPending 을 부르기 전에 크론이 대기 행을 가져가면 결과가 흔들린다.
    const scheduler = app.get(SchedulerRegistry);
    await scheduler.getCronJob(BATCH_JOB.EXCEL_EXPORT).stop();
    await scheduler.getCronJob(BATCH_JOB.EXCEL_DOWNLOAD_PURGE).stop();
    prisma = app.get(PrismaService);
    exports = app.get(ExcelExportsService);
    app.get(ExcelExportRegistry).register(source);
    app.get(ExcelExportRegistry).register(otherSource);
    ({ adminAccountId: adminId } = await prisma.adminAccount.findFirstOrThrow({
      where: { loginId: 'whaleadmin' },
    }));
    ({ menuId } = await prisma.menu.findFirstOrThrow({
      where: { url: MENU_URL },
    }));
    caller = { adminAccountId: adminId, bp: null };
    // 받는 주소가 있어야 예약 생성을 받는다
    await prisma.adminAccount.update({
      where: { adminAccountId: adminId },
      data: { email: 'rjy1537@interplug.co.kr' },
    });
  });

  beforeEach(async () => {
    await clearLogs();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    try {
      if (prisma) await clearLogs();
    } finally {
      await app?.close();
    }
  });

  it('1만 건 미만은 바로 파일을 주고, 바로 받기 완료 이력을 남긴다', async () => {
    source.count.mockResolvedValue(9_999);
    source.build.mockResolvedValue(Buffer.from('xlsx'));

    const result = await exports.request(
      source,
      caller,
      Object.assign(new TestQuery(), { keyword: '판교' }),
      T0,
    );

    expect(result).toEqual({
      kind: 'file',
      fileName: '시험목록_20990302.xlsx',
      buffer: Buffer.from('xlsx'),
    });
    const [log] = await logs();
    expect(log).toMatchObject({
      deliveryMethod: 'DIRECT',
      status: 'SUCCEEDED',
      rowCount: 9_999,
      fileName: '시험목록_20990302.xlsx',
      searchConditions: { keyword: '판교' },
      bpCodeId: null,
      storageKey: null,
      requestedAt: T0,
    });
    expect(log.completedAt).not.toBeNull();
  });

  it('화면의 건수 세기가 DB 를 읽어도 멈추지 않는다 — 잠금 트랜잭션이 커넥션을 쥔 채 기다리지 않게', async () => {
    // 실제 화면처럼 주입받은 PrismaService 로 센다. 커넥션 하나(E2E_SINGLE_BACKEND)에서 트랜잭션 안에서 부르면 교착이다.
    source.count.mockImplementation(async () => {
      await prisma.menu.count();
      return 1;
    });
    source.build.mockImplementation(async () => {
      await prisma.menu.count();
      return Buffer.from('x');
    });

    await expect(
      exports.request(source, caller, new TestQuery(), T0),
    ).resolves.toMatchObject({ kind: 'file' });
  }, 15_000);

  it('동시에 두 번 눌러도 이력은 하나다 — 잠금 안에서 다시 판단해 뒤 요청은 409 · 429', async () => {
    // 둘 다 잠금 없는 1차 판단을 지난 뒤 건수를 세도록, 세는 동안 잠깐 쉰다.
    source.count.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 1;
    });
    source.build.mockResolvedValue(Buffer.from('x'));

    const statuses = await Promise.all([
      statusOf(() => exports.request(source, caller, new TestQuery(), T0)),
      statusOf(() => exports.request(source, caller, new TestQuery(), T0)),
    ]);

    expect(source.count).toHaveBeenCalledTimes(2);
    expect(statuses.filter((s) => s === 0)).toHaveLength(1);
    expect([409, 429]).toContain(statuses.find((s) => s !== 0));
    expect(await logs()).toHaveLength(1);
  }, 15_000);

  it('같은 화면은 1분에 한 번 — 1분 안이면 429, 지나면 받는다', async () => {
    source.count.mockResolvedValue(1);
    source.build.mockResolvedValue(Buffer.from('x'));
    await exports.request(source, caller, new TestQuery(), T0);

    expect(
      await statusOf(() =>
        exports.request(source, caller, new TestQuery(), at(MINUTE - 1)),
      ),
    ).toBe(429);
    await expect(
      exports.request(source, caller, new TestQuery(), at(MINUTE)),
    ).resolves.toMatchObject({ kind: 'file' });
  });

  it('범위 · 권한 거절(4xx)은 이력을 남기지 않아 1분에 세지 않는다', async () => {
    source.count.mockRejectedValueOnce(
      new HttpException('BP 를 골라 주세요', 400),
    );
    expect(
      await statusOf(() =>
        exports.request(source, caller, new TestQuery(), T0),
      ),
    ).toBe(400);
    expect(await logs()).toHaveLength(0);
  });

  it('1만 건부터 예약 생성 — 대기 이력만 남기고, 생성 중에는 같은 화면 요청을 409 로 막는다', async () => {
    source.count.mockResolvedValue(12_480);

    const result = await exports.request(source, caller, new TestQuery(), T0);

    expect(result).toMatchObject({ kind: 'scheduled', rowCount: 12_480 });
    expect(source.build).not.toHaveBeenCalled();
    const [log] = await logs();
    expect(log).toMatchObject({
      deliveryMethod: 'SCHEDULED',
      status: 'PENDING',
      attemptCount: 0,
    });
    // 1분이 지나도 생성 중이면 막는다
    expect(
      await statusOf(() =>
        exports.request(source, caller, new TestQuery(), at(10 * MINUTE)),
      ),
    ).toBe(409);
  });

  it('생성 중 하나만 — 부분 고유 인덱스가 DB 에서도 막는다', async () => {
    const row = {
      requestedBy: adminId,
      menuId,
      rowCount: 1,
      deliveryMethod: 'SCHEDULED' as const,
      status: 'PENDING' as const,
      fileName: 'x.xlsx',
    };
    await prisma.excelDownloadLog.create({ data: row });
    await expect(
      prisma.excelDownloadLog.create({
        data: { ...row, status: 'PROCESSING', startedAt: T0 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('생성 중인데 시작 시각이 없거나, 바로 받기가 대기면 CHECK 가 막는다 — 영영 409 · 메일로 가는 바로 받기를 만들지 않게', async () => {
    const row = {
      requestedBy: adminId,
      menuId,
      rowCount: 1,
      fileName: 'x.xlsx',
    };
    const violation = (constraint: string): unknown =>
      expect.objectContaining({
        message: expect.stringContaining(constraint),
      });
    await expect(
      prisma.excelDownloadLog.create({
        data: { ...row, deliveryMethod: 'SCHEDULED', status: 'PROCESSING' },
      }),
    ).rejects.toEqual(violation('excel_download_logs_started_when_processing'));
    await expect(
      prisma.excelDownloadLog.create({
        data: { ...row, deliveryMethod: 'DIRECT', status: 'PENDING' },
      }),
    ).rejects.toEqual(violation('excel_download_logs_direct_not_pending'));
    expect(await logs()).toHaveLength(0);
  });

  it('배치가 동시에 둘 돌아도 한 작업은 한 번만 만든다(SKIP LOCKED) — 둘이면 하나씩 나눠 갖는다', async () => {
    const base = {
      requestedBy: adminId,
      menuId,
      rowCount: 10_000,
      deliveryMethod: 'SCHEDULED' as const,
      status: 'PENDING' as const,
      fileName: 'x.xlsx',
    };
    // 생성 중 하나만(부분 고유 인덱스)이라 같은 화면엔 대기 하나 — 두 번째 시험 화면으로 하나 더 둔다
    const other = await prisma.menu.findFirstOrThrow({
      where: { url: OTHER_MENU_URL },
    });
    await prisma.excelDownloadLog.createMany({
      data: [
        { ...base, requestedAt: T0 },
        { ...base, menuId: other.menuId, requestedAt: at(1) },
      ],
    });
    // 두 실행이 겹치게 만들기를 늦춘다. 두 번째 화면 작업은 권한에 따라 실패할 수 있다 — 여기선 몇 번 집혔는지만 본다.
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Buffer.from('x');
    };
    source.build.mockImplementation(slow);
    otherSource.build.mockImplementation(slow);

    // 실제 시각으로 돌린다 — 가져갈 때 적는 started_at 은 실제 시각이라, 미래 시각(T0)을 넘기면 다른 실행의 멈춘 작업
    // 정리가 막 시작한 작업을 「1시간 넘게 멈춤」으로 보고 다시 가져간다(운영에서는 같은 시계라 생기지 않는다).
    const counts = await Promise.all([
      exports.processPending(),
      exports.processPending(),
    ]);

    // 각 실행은 자기가 가져간 것만 센다 — 합이 2(작업 수)이고, 이 화면 작업은 한 번만 만들었다
    expect(counts[0] + counts[1]).toBe(2);
    expect(source.build).toHaveBeenCalledTimes(1);
    expect(otherSource.build.mock.calls.length).toBeLessThanOrEqual(1);
    const mine = await logs();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
    const [second] = await prisma.excelDownloadLog.findMany({
      where: { requestedBy: adminId, menuId: other.menuId },
    });
    expect(second.attemptCount).toBe(1);
    await prisma.excelDownloadLog.deleteMany({
      where: { requestedBy: adminId, menuId: other.menuId },
    });
  }, 15_000);

  it('이 앱에 소스가 없는 화면의 대기 작업은 가져가지 않는다 — 만들 수 없는 작업에 시도를 쓰지 않게', async () => {
    const unregistered = await prisma.menu.findFirstOrThrow({
      where: { url: UNREGISTERED_MENU_URL },
    });
    const { excelDownloadId } = await prisma.excelDownloadLog.create({
      data: {
        requestedBy: adminId,
        menuId: unregistered.menuId,
        rowCount: 10_000,
        deliveryMethod: 'SCHEDULED',
        status: 'PENDING',
        fileName: 'x.xlsx',
        requestedAt: T0,
      },
    });
    try {
      await expect(exports.processPending()).resolves.toBe(0);
      expect(
        await prisma.excelDownloadLog.findUniqueOrThrow({
          where: { excelDownloadId },
        }),
      ).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    } finally {
      await prisma.excelDownloadLog.delete({ where: { excelDownloadId } });
    }
  });

  it('배치가 파일을 만들어 S3 에 올리고 24시간 기한으로 완료 · 준비 메일을 보낸다', async () => {
    source.count.mockResolvedValue(12_480);
    source.build.mockResolvedValue(Buffer.from('big'));
    const { excelDownloadId } = (await exports.request(
      source,
      caller,
      Object.assign(new TestQuery(), { keyword: '강남' }),
      T0,
    )) as { excelDownloadId: number };

    expect(await exports.processPending(at(MINUTE))).toBe(1);

    // 저장해 둔 조건을 같은 클래스로 다시 읽어 부른다
    const [, query] = source.build.mock.calls[0];
    expect(query).toBeInstanceOf(TestQuery);
    expect(query).toEqual({ keyword: '강남' });
    const [key, body, kind] = storage.put.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(key).toMatch(
      new RegExp(`^excel-exports/${adminId}/[0-9a-f-]{36}\\.xlsx$`),
    );
    expect([body, kind]).toEqual([Buffer.from('big'), 'XLSX']);
    const log = await prisma.excelDownloadLog.findUniqueOrThrow({
      where: { excelDownloadId },
    });
    expect(log).toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 1,
      storageKey: key,
    });
    expect(log.startedAt).not.toBeNull();
    // 기한은 실제로 다 만든 시각부터 24시간
    expect(log.expiresAt!.getTime() - log.completedAt!.getTime()).toBe(
      24 * 60 * MINUTE,
    );
    expect(log.notifiedAt).not.toBeNull();
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'EMAIL_EXCEL_READY',
        to: 'rjy1537@interplug.co.kr',
        adminAccountId: adminId,
        variables: expect.objectContaining({
          화면: '시험 목록',
          건수: '12,480',
          // 관리자 웹 화면 — 로그인한 본인만 api 에서 파일 주소를 받는다
          링크: expect.stringMatching(
            new RegExp(`^https?://.+/excel-downloads/${excelDownloadId}$`),
          ),
        }),
      }),
    );
    // 할 일이 없으면 0
    expect(await exports.processPending(at(2 * MINUTE))).toBe(0);
  });

  it('내려받기는 요청한 본인만, 24시간 안에만 — 받으면 받은 시각을 남긴다', async () => {
    source.count.mockResolvedValue(10_000);
    source.build.mockResolvedValue(Buffer.from('x'));
    const { excelDownloadId: id } = (await exports.request(
      source,
      caller,
      new TestQuery(),
      T0,
    )) as { excelDownloadId: number };
    // 아직 만들지 않았다
    expect(await statusOf(() => exports.download(adminId, id, T0))).toBe(409);
    await exports.processPending(T0);
    // 기한은 실제 완료 시각부터다 — 그 앞뒤로 받아 본다
    const { expiresAt } = await prisma.excelDownloadLog.findUniqueOrThrow({
      where: { excelDownloadId: id },
    });
    const before = new Date(expiresAt!.getTime() - MINUTE);

    expect(
      await statusOf(() => exports.download(adminId + 999_999, id, before)),
    ).toBe(404);
    await expect(exports.download(adminId, id, before)).resolves.toEqual({
      url: 'https://s3.example.com/signed',
      fileName: '시험목록_20990302.xlsx',
      expiresAt: expiresAt!.toISOString(),
    });
    expect(
      (
        await prisma.excelDownloadLog.findUniqueOrThrow({
          where: { excelDownloadId: id },
        })
      ).downloadedAt,
    ).toEqual(before);
    expect(
      await statusOf(() => exports.download(adminId, id, expiresAt!)),
    ).toBe(410);
    // 만든 뒤 화면의 호출자 조건을 잃으면(예: 플랫폼 계정이 아니게 됨) 기한 안이어도 403 — 주소를 주지 않는다
    source.assertRequester.mockRejectedValueOnce(
      new ForbiddenException('플랫폼 계정이 아님'),
    );
    storage.downloadUrl.mockClear();
    expect(await statusOf(() => exports.download(adminId, id, before))).toBe(
      403,
    );
    expect(storage.downloadUrl).not.toHaveBeenCalled();
    // 만든 때의 범위 지문이 이력에 남고, 받을 때 범위가 달라졌으면(예: 일부 점포로 좁혀짐) 403
    expect(
      (
        await prisma.excelDownloadLog.findUniqueOrThrow({
          where: { excelDownloadId: id },
        })
      ).scopeKey,
    ).toBe('scope-A');
    source.scopeKey.mockResolvedValueOnce('scope-B');
    expect(await statusOf(() => exports.download(adminId, id, before))).toBe(
      403,
    );
    expect(storage.downloadUrl).not.toHaveBeenCalled();
  });

  it('생성이 실패하면 한 번 다시 시도하고, 두 번째도 실패면 실패로 끝내고 실패 메일을 보낸다', async () => {
    source.count.mockResolvedValue(10_000);
    source.build.mockRejectedValue(new Error('S3 timeout'));
    const { excelDownloadId: id } = (await exports.request(
      source,
      caller,
      new TestQuery(),
      T0,
    )) as { excelDownloadId: number };

    await exports.processPending(at(MINUTE));
    let log = await prisma.excelDownloadLog.findUniqueOrThrow({
      where: { excelDownloadId: id },
    });
    expect(log).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      failureReason: 'S3 timeout',
    });
    expect(mail.send).not.toHaveBeenCalled();

    await exports.processPending(at(2 * MINUTE));
    log = await prisma.excelDownloadLog.findUniqueOrThrow({
      where: { excelDownloadId: id },
    });
    expect(log).toMatchObject({ status: 'FAILED', attemptCount: 2 });
    expect(log.notifiedAt).not.toBeNull();
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'EMAIL_EXCEL_FAILED',
        variables: { 화면: '시험 목록', 요청일시: '2099-03-02 09:00' },
      }),
    );
    // 실패로 끝나면 다시 요청할 수 있다(1분이 지난 뒤)
    source.count.mockResolvedValue(1);
    source.build.mockResolvedValue(Buffer.from('x'));
    await expect(
      exports.request(source, caller, new TestQuery(), at(3 * MINUTE)),
    ).resolves.toMatchObject({ kind: 'file' });
  });

  it('바로 받기 중 서버가 죽어 생성 중으로 남은 이력은 10분 뒤 실패로 정리한다 — 같은 화면이 막히지 않게', async () => {
    await prisma.excelDownloadLog.create({
      data: {
        requestedBy: adminId,
        menuId,
        rowCount: 1,
        deliveryMethod: 'DIRECT',
        status: 'PROCESSING',
        fileName: 'x.xlsx',
        requestedAt: T0,
        startedAt: T0,
      },
    });
    source.count.mockResolvedValue(1);
    source.build.mockResolvedValue(Buffer.from('x'));

    await exports.processPending(at(10 * MINUTE));

    const [stuck] = await logs();
    expect(stuck).toMatchObject({ status: 'FAILED' });
    await expect(
      exports.request(source, caller, new TestQuery(), at(11 * MINUTE)),
    ).resolves.toMatchObject({ kind: 'file' });
  });

  it('예약 생성의 멈춤은 이번 시도를 시작한 시각으로 잰다 — 오래 기다렸다 막 시작한 작업은 빼앗지 않는다', async () => {
    const base = {
      requestedBy: adminId,
      menuId,
      rowCount: 10_000,
      deliveryMethod: 'SCHEDULED' as const,
      status: 'PROCESSING' as const,
      fileName: 'x.xlsx',
      attemptCount: 1,
      requestedAt: T0,
    };
    const { excelDownloadId: id } = await prisma.excelDownloadLog.create({
      data: { ...base, startedAt: at(2 * 60 * MINUTE) },
    });

    // 요청부터는 3시간, 시작부터는 1시간이 안 됐다 — 그대로 둔다
    await exports.processPending(at(3 * 60 * MINUTE - 1));
    expect(
      await prisma.excelDownloadLog.findUniqueOrThrow({
        where: { excelDownloadId: id },
      }),
    ).toMatchObject({ status: 'PROCESSING', attemptCount: 1 });

    // 시작부터 1시간 — 멈춘 것으로 보고 다시 대기, 같은 실행에서 다시 가져가 만든다
    source.build.mockResolvedValue(Buffer.from('x'));
    await exports.processPending(at(3 * 60 * MINUTE));
    expect(
      await prisma.excelDownloadLog.findUniqueOrThrow({
        where: { excelDownloadId: id },
      }),
    ).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });
  });

  it('기한이 지난 지 7일 안의 예약 생성 파일을 S3 에서 지운다', async () => {
    const base = {
      requestedBy: adminId,
      menuId,
      rowCount: 10_000,
      deliveryMethod: 'SCHEDULED' as const,
      status: 'SUCCEEDED' as const,
      fileName: 'x.xlsx',
    };
    const day = 24 * 60 * MINUTE;
    await prisma.excelDownloadLog.createMany({
      data: [
        // 기한 안 · 지난 지 1일 · 지난 지 8일(이미 지웠을 것)
        { ...base, storageKey: 'excel-exports/1/a.xlsx', expiresAt: at(day) },
        { ...base, storageKey: 'excel-exports/1/b.xlsx', expiresAt: at(-day) },
        {
          ...base,
          storageKey: 'excel-exports/1/c.xlsx',
          expiresAt: at(-8 * day),
          requestedAt: at(-9 * day),
        },
      ].map((row) => ({ requestedAt: at(-2 * day), ...row })),
    });

    await expect(exports.deleteExpiredFiles(T0)).resolves.toBe(1);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('excel-exports/1/b.xlsx');
  });

  it('2년이 지난 이력은 파기 배치가 지운다', async () => {
    const base = {
      requestedBy: adminId,
      menuId,
      rowCount: 1,
      deliveryMethod: 'DIRECT' as const,
      status: 'SUCCEEDED' as const,
      fileName: 'x.xlsx',
    };
    await prisma.excelDownloadLog.createMany({
      data: [
        { ...base, requestedAt: new Date('2097-03-01T23:59:59.000Z') },
        { ...base, requestedAt: new Date('2097-03-02T00:00:01.000Z') },
      ],
    });

    const deleted = await prisma.$transaction((tx) =>
      exports.purgeExpired(tx, T0),
    );

    expect(deleted).toBe(1);
    expect((await logs()).map((l) => l.requestedAt)).toEqual([
      new Date('2097-03-02T00:00:01.000Z'),
    ]);
  });
});
