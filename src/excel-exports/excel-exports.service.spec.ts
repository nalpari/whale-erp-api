// prisma · tx 는 쓰는 메서드만 둔 jest 목이라 any 다 — 호출 인자를 꺼내 보는 검사가 많아 파일 단위로 끈다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ExcelExportRegistry } from './excel-export-registry';
import type { ExcelExportSource } from './excel-export-source';
import { ExcelExportsService } from './excel-exports.service';

// 잠금 · 동시성 · 실제 SQL(SKIP LOCKED, 부분 고유 인덱스)은 test/excel-exports.e2e-spec.ts 가 진짜 DB 로 본다.
// 여기서는 상태 전이 · 메일 · 저장소를 부르는 순서와 조건을 본다.

class Query {
  keyword?: string;
}

const NOW = new Date('2026-10-28T05:00:00.000Z');
const HOUR = 60 * 60_000;

function job(overrides: Record<string, unknown> = {}) {
  return {
    excelDownloadId: 31,
    requestedBy: 7,
    menuId: 4,
    bpCodeId: null,
    searchConditions: { keyword: '한강' },
    rowCount: 12_000,
    deliveryMethod: 'SCHEDULED',
    status: 'PROCESSING',
    fileName: 'BP목록_20261028.xlsx',
    storageKey: null,
    attemptCount: 1,
    failureReason: null,
    notifiedAt: null,
    expiresAt: null,
    downloadedAt: null,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe('ExcelExportsService', () => {
  let service: ExcelExportsService;
  let prisma: any;
  let tx: any;
  let storage: any;
  let mail: any;
  let source: Omit<ExcelExportSource<Query>, 'count' | 'build'> & {
    count: jest.Mock;
    build: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      excelDownloadLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }) =>
          Promise.resolve({ excelDownloadId: 31, ...data }),
        ),
      },
      adminAccount: {
        findUnique: jest.fn().mockResolvedValue({ email: 'a@b.kr' }),
      },
    };
    prisma = {
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      menu: {
        findFirst: jest.fn().mockResolvedValue({ menuId: 4 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ url: '/bp-masters' }),
        findUnique: jest.fn().mockResolvedValue({ url: '/bp-masters' }),
      },
      excelDownloadLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminAccount: {
        findUnique: jest.fn().mockResolvedValue({ email: 'a@b.kr' }),
        findUniqueOrThrow: jest.fn(),
      },
    };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      downloadUrl: jest.fn().mockResolvedValue('https://s3/signed'),
    };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    source = {
      menuUrl: '/bp-masters',
      screenName: 'BP 목록',
      queryType: Query,
      fileName: jest.fn().mockReturnValue('BP목록_20261028.xlsx'),
      count: jest.fn().mockResolvedValue(3),
      build: jest.fn().mockResolvedValue(Buffer.from('PK')),
    };
    const registry = new ExcelExportRegistry();
    registry.register(source);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExcelExportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExcelExportRegistry, useValue: registry },
        { provide: STORAGE, useValue: storage },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
        {
          provide: ConfigService,
          useValue: { get: () => 'https://admin.example.com' },
        },
      ],
    }).compile();
    service = moduleRef.get(ExcelExportsService);
  });

  describe('request', () => {
    const caller = { adminAccountId: 7, bp: null };

    it('1만 건 미만은 생성 중으로 적고(시작 시각 = 요청) 파일을 만든 뒤 완료로 바꾼다', async () => {
      const result = await service.request(source, caller, new Query(), NOW);
      expect(result).toEqual({
        kind: 'file',
        fileName: 'BP목록_20261028.xlsx',
        buffer: Buffer.from('PK'),
      });
      const { data } = tx.excelDownloadLog.create.mock.calls[0][0];
      expect(data).toEqual(
        expect.objectContaining({
          deliveryMethod: 'DIRECT',
          status: 'PROCESSING',
          requestedAt: NOW,
          startedAt: NOW,
        }),
      );
      expect(prisma.excelDownloadLog.update).toHaveBeenCalledWith({
        where: { excelDownloadId: 31 },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      });
    });

    it('1만 건부터는 대기 이력만 남기고 202 재료를 돌려준다 — 파일은 만들지 않는다', async () => {
      source.count.mockResolvedValue(10_000);
      const result = await service.request(source, caller, new Query(), NOW);
      expect(result).toEqual({
        kind: 'scheduled',
        excelDownloadId: 31,
        rowCount: 10_000,
      });
      const { data } = tx.excelDownloadLog.create.mock.calls[0][0];
      expect(data).toEqual(
        expect.objectContaining({
          deliveryMethod: 'SCHEDULED',
          status: 'PENDING',
        }),
      );
      expect(data.startedAt).toBeUndefined();
      expect(source.build).not.toHaveBeenCalled();
    });

    it('건수는 트랜잭션 밖에서 센다 — 트랜잭션이 커넥션을 쥔 채 세면 교착이다', async () => {
      const order: string[] = [];
      source.count.mockImplementation(() => {
        order.push('count');
        return Promise.resolve(3);
      });
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) => {
        order.push('transaction');
        return fn(tx);
      });
      await service.request(source, caller, new Query(), NOW);
      expect(order).toEqual(['count', 'transaction']);
    });

    it('같은 화면이 생성 중이면 세지도 않고 409', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValue({
        status: 'PENDING',
        requestedAt: new Date(NOW.getTime() - 5 * HOUR),
      });
      await expect(
        service.request(source, caller, new Query(), NOW),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(source.count).not.toHaveBeenCalled();
    });

    it('잠금 안에서 다시 보면 그 사이 들어온 요청 때문에 429 — 이력을 쓰지 않는다', async () => {
      tx.excelDownloadLog.findFirst.mockResolvedValue({
        status: 'SUCCEEDED',
        requestedAt: NOW,
      });
      const error = await service
        .request(source, caller, new Query(), NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect(tx.excelDownloadLog.create).not.toHaveBeenCalled();
    });
  });

  describe('processPending — 예약 생성', () => {
    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 31 }])
        .mockResolvedValue([]);
      prisma.excelDownloadLog.findUnique.mockResolvedValue(job());
    });

    it('만들어 S3 에 두고, 이 시도가 아직 자기 것일 때만 완료로 바꾼 뒤 메일을 보낸다', async () => {
      const before = Date.now();
      await expect(service.processPending(NOW)).resolves.toBe(1);
      const key = storage.put.mock.calls[0][0] as string;
      expect(key).toMatch(/^excel-exports\/7\/[0-9a-f-]+\.xlsx$/);
      const done = prisma.excelDownloadLog.updateMany.mock.calls.find(
        ([arg]) => arg.data.status === 'SUCCEEDED',
      )[0];
      expect(done.where).toEqual({
        excelDownloadId: 31,
        status: 'PROCESSING',
        attemptCount: 1,
      });
      // 기한은 실제로 다 만든 시각부터 24시간 — 배치가 시작한 시각(NOW)이 아니다.
      expect(done.data.completedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(
        done.data.expiresAt.getTime() - done.data.completedAt.getTime(),
      ).toBe(24 * HOUR);
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'EMAIL_EXCEL_READY',
          to: 'a@b.kr',
          variables: expect.objectContaining({
            화면: 'BP 목록',
            건수: '12,000',
            링크: 'https://admin.example.com/excel-downloads/31',
          }),
        }),
      );
    });

    it('그 사이 다른 처리가 이 작업을 가져갔으면(0행) 메일을 보내지 않고 올린 파일을 지운다', async () => {
      prisma.excelDownloadLog.updateMany.mockResolvedValue({ count: 0 });
      await service.processPending(NOW);
      const key = storage.put.mock.calls[0][0] as string;
      expect(storage.delete).toHaveBeenCalledWith(key);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('첫 시도가 실패하면 다시 대기로 — 메일은 없다', async () => {
      source.build.mockRejectedValue(new Error('boom'));
      await service.processPending(NOW);
      expect(prisma.excelDownloadLog.updateMany).toHaveBeenCalledWith({
        where: { excelDownloadId: 31, status: 'PROCESSING', attemptCount: 1 },
        data: { status: 'PENDING', failureReason: 'boom' },
      });
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('두 번째 시도도 실패하면 실패로 끝내고 실패 메일', async () => {
      prisma.excelDownloadLog.findUnique.mockResolvedValue(
        job({ attemptCount: 2 }),
      );
      source.build.mockRejectedValue(new Error('boom'));
      await service.processPending(NOW);
      expect(prisma.excelDownloadLog.updateMany).toHaveBeenCalledWith({
        where: { excelDownloadId: 31, status: 'PROCESSING', attemptCount: 2 },
        data: { status: 'FAILED', failureReason: 'boom' },
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: 'EMAIL_EXCEL_FAILED' }),
      );
    });

    it('메일 받을 주소를 읽다 실패해도 완료된 작업을 되돌리지 않는다', async () => {
      prisma.adminAccount.findUnique.mockRejectedValue(new Error('db down'));
      await service.processPending(NOW);
      // 멈춘 작업 정리(바로 받기 일괄)는 빼고, 이 작업의 상태 전이만 본다.
      const statuses = prisma.excelDownloadLog.updateMany.mock.calls
        .filter(([arg]) => arg.where.excelDownloadId === 31)
        .map(([arg]) => arg.data.status);
      expect(statuses).toEqual(['SUCCEEDED']);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('멈춘 작업은 이번 시도를 시작한 시각으로 판단한다 — 오래 기다린 작업이 막 시작하자마자 빼앗기지 않게', async () => {
      await service.processPending(NOW);
      const [stuck] = prisma.excelDownloadLog.findMany.mock.calls[0];
      expect(stuck.where).toEqual({
        deliveryMethod: 'SCHEDULED',
        status: 'PROCESSING',
        startedAt: { lte: new Date(NOW.getTime() - HOUR) },
      });
      const [direct] = prisma.excelDownloadLog.updateMany.mock.calls[0];
      expect(direct.where).toEqual(
        expect.objectContaining({
          deliveryMethod: 'DIRECT',
          startedAt: { lte: new Date(NOW.getTime() - 10 * 60_000) },
        }),
      );
    });
  });

  describe('download', () => {
    it('본인 · 예약 생성이 아니면 404', async () => {
      await expect(service.download(7, 31, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.excelDownloadLog.findFirst).toHaveBeenCalledWith({
        where: {
          excelDownloadId: 31,
          requestedBy: 7,
          deliveryMethod: 'SCHEDULED',
        },
      });
    });

    it('아직 만드는 중이면 409, 기한이 지났으면 410', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({ status: 'PENDING' }),
      );
      await expect(service.download(7, 31, NOW)).rejects.toBeInstanceOf(
        ConflictException,
      );
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({
          status: 'SUCCEEDED',
          storageKey: 'excel-exports/7/a.xlsx',
          expiresAt: NOW,
        }),
      );
      await expect(service.download(7, 31, NOW)).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it('기한 안이면 짧은 주소를 주고 받은 시각을 남긴다', async () => {
      const expiresAt = new Date(NOW.getTime() + HOUR);
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({
          status: 'SUCCEEDED',
          storageKey: 'excel-exports/7/a.xlsx',
          expiresAt,
        }),
      );
      await expect(service.download(7, 31, NOW)).resolves.toEqual({
        url: 'https://s3/signed',
        fileName: 'BP목록_20261028.xlsx',
        expiresAt: expiresAt.toISOString(),
      });
      expect(storage.downloadUrl).toHaveBeenCalledWith(
        'excel-exports/7/a.xlsx',
        'BP목록_20261028.xlsx',
      );
      expect(prisma.excelDownloadLog.update).toHaveBeenCalledWith({
        where: { excelDownloadId: 31 },
        data: { downloadedAt: NOW },
      });
    });
  });

  describe('deleteExpiredFiles — 기한이 지난 S3 파일', () => {
    it('최근 7일 안에 기한이 지난 파일을 지운다 — 하나가 실패해도 나머지는 지운다', async () => {
      prisma.excelDownloadLog.findMany.mockResolvedValue([
        { storageKey: 'excel-exports/7/a.xlsx' },
        { storageKey: 'excel-exports/7/b.xlsx' },
      ]);
      storage.delete.mockRejectedValueOnce(new Error('s3'));
      await expect(service.deleteExpiredFiles(NOW)).resolves.toBe(1);
      expect(prisma.excelDownloadLog.findMany).toHaveBeenCalledWith({
        where: {
          deliveryMethod: 'SCHEDULED',
          status: 'SUCCEEDED',
          storageKey: { not: null },
          expiresAt: {
            lte: NOW,
            gt: new Date(NOW.getTime() - 7 * 24 * HOUR),
          },
        },
        select: { storageKey: true },
      });
      expect(storage.delete).toHaveBeenCalledTimes(2);
    });
  });
});
