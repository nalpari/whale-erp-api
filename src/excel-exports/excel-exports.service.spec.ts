// prisma · tx 는 쓰는 메서드만 둔 jest 목이라 any 다 — 호출 인자를 꺼내 보는 검사가 많아 파일 단위로 끈다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
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
  let source: Omit<
    ExcelExportSource<Query>,
    'count' | 'build' | 'assertRequester'
  > & {
    count: jest.Mock;
    build: jest.Mock;
    assertRequester: jest.Mock;
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
        // 메뉴 조회 권한(adminHasMenuAction) — 쓸 수 있는 계정 · 권한 행 1개
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 2 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
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
      assertRequester: jest.fn().mockResolvedValue(undefined),
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

    it('바로 받기가 만드는 중이면 409 — 메일로 알린다고 하지 않는다(바로 받기는 메일이 없다)', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValue({
        status: 'PROCESSING',
        deliveryMethod: 'DIRECT',
        requestedAt: NOW,
      });
      const error = await service
        .request(source, caller, new Query(), NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(
        '엑셀 파일을 만드는 중입니다. 잠시 뒤 다시 받아 주세요',
      );
    });

    it('바로 받기 파일을 만들다 실패하면 실패로 적고 원래 오류를 던진다 — 적기마저 실패해도 원래 오류다', async () => {
      source.build.mockRejectedValue(new Error('boom'));
      prisma.excelDownloadLog.update.mockRejectedValue(new Error('db down'));
      await expect(
        service.request(source, caller, new Query(), NOW),
      ).rejects.toThrow('boom');
      expect(prisma.excelDownloadLog.update).toHaveBeenCalledWith({
        where: { excelDownloadId: 31 },
        data: { status: 'FAILED', failureReason: 'boom' },
      });
    });

    it('예약 생성에 필요한 설정(메일 · 관리자 웹 주소 · 저장소)이 없으면 503 — 이력을 쓰지 않는다', async () => {
      source.count.mockResolvedValue(10_000);
      const registry = new ExcelExportRegistry();
      registry.register(source);
      const noMail = new ExcelExportsService(prisma, registry, storage, null, {
        get: () => 'https://admin.example.com',
      } as unknown as ConfigService);
      await expect(
        noMail.request(source, caller, new Query(), NOW),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(tx.excelDownloadLog.create).not.toHaveBeenCalled();
    });

    it('받을 이메일이 없으면 1만 건 이상은 400, 1만 건 미만은 막지 않는다', async () => {
      tx.adminAccount.findUnique.mockResolvedValue({ email: null });
      source.count.mockResolvedValue(10_000);
      await expect(
        service.request(source, caller, new Query(), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.excelDownloadLog.create).not.toHaveBeenCalled();
      source.count.mockResolvedValue(9_999);
      await expect(
        service.request(source, caller, new Query(), NOW),
      ).resolves.toMatchObject({ kind: 'file' });
    });

    it('등록부에 없는 소스는 설정 잘못이다 — 바로 받기는 되고 예약 생성만 배치에서 실패하는 일이 없게 먼저 막는다', async () => {
      const stray = { ...source, menuUrl: '/bp-masters' };
      await expect(
        service.request(stray, caller, new Query(), NOW),
      ).rejects.toThrow('엑셀 소스가 등록되지 않았습니다');
      expect(stray.count).not.toHaveBeenCalled();
    });

    it('부분 고유 인덱스에 걸리면(P2002) 500 이 아니라 409', async () => {
      tx.excelDownloadLog.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.request(source, caller, new Query(), NOW),
      ).rejects.toBeInstanceOf(ConflictException);
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

    it('만들기 전에 요청자가 지금도 그 화면의 조회 권한을 가졌는지 본다 — 없으면 다시 시도하지 않고 바로 실패', async () => {
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      await service.processPending(NOW);
      expect(source.build).not.toHaveBeenCalled();
      expect(prisma.excelDownloadLog.updateMany).toHaveBeenCalledWith({
        where: { excelDownloadId: 31, status: 'PROCESSING', attemptCount: 1 },
        data: {
          status: 'FAILED',
          failureReason: expect.stringMatching(/^\[403\] /),
        },
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: 'EMAIL_EXCEL_FAILED' }),
      );
    });

    it('화면이 4xx 로 거절하면(계정 막힘 등) 다시 해도 같으므로 첫 시도에서 실패로 끝낸다', async () => {
      source.build.mockRejectedValue(new ForbiddenException('막힌 계정'));
      await service.processPending(NOW);
      expect(prisma.excelDownloadLog.updateMany).toHaveBeenCalledWith({
        where: { excelDownloadId: 31, status: 'PROCESSING', attemptCount: 1 },
        data: { status: 'FAILED', failureReason: '[403] 막힌 계정' },
      });
    });

    it('한 작업의 실패 기록이 던져도 이번 실행의 다음 작업은 만든다', async () => {
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 31 }])
        .mockResolvedValueOnce([{ id: 32 }])
        .mockResolvedValue([]);
      prisma.excelDownloadLog.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(job({ excelDownloadId: where.excelDownloadId })),
      );
      source.build
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(Buffer.from('PK'));
      prisma.excelDownloadLog.updateMany.mockImplementation(({ where }) =>
        where.excelDownloadId === 31
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ count: 1 }),
      );
      await expect(service.processPending(NOW)).resolves.toBe(2);
      expect(source.build).toHaveBeenCalledTimes(2);
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'EMAIL_EXCEL_READY',
          variables: expect.objectContaining({
            링크: 'https://admin.example.com/excel-downloads/32',
          }),
        }),
      );
    });

    it('메일 실패 로그에 받는 주소를 싣지 않는다 — SMTP 오류 문구에는 주소가 섞인다', async () => {
      const logged: string[] = [];
      const capture = (message: unknown) => logged.push(String(message));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
      mail.send.mockRejectedValue(new Error('550 mailbox <a@b.kr> unknown'));
      await service.processPending(NOW);
      expect(logged.some((m) => m.includes('mail FAILED'))).toBe(true);
      expect(logged.join('\n')).not.toContain('a@b.kr');
      jest.restoreAllMocks();
    });

    it('대상 BP 가 있는 작업은 지금의 계정으로 플랫폼 여부를 다시 정해 호출자를 만든다', async () => {
      prisma.excelDownloadLog.findUnique.mockResolvedValue(
        job({ bpCodeId: 3 }),
      );
      prisma.adminAccount.findUniqueOrThrow.mockResolvedValue({
        roleTypeCode: 'BM',
        bpCode: { isPlatform: false },
      });
      await service.processPending(NOW);
      expect(source.build.mock.calls[0][0]).toEqual({
        adminAccountId: 7,
        bp: { bpCodeId: 3, isPlatformCaller: false },
      });
    });

    it('등록한 화면이 하나도 없으면 대기 작업을 가져가지 않는다 — 만들 수 없는 작업을 집어 실패시키지 않게', async () => {
      const empty = new ExcelExportsService(
        prisma,
        new ExcelExportRegistry(),
        storage,
        mail,
        { get: () => 'https://admin.example.com' } as unknown as ConfigService,
      );
      prisma.$queryRaw.mockClear();
      await expect(empty.processPending(NOW)).resolves.toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('마지막 시도에서 멈춘 작업은 실패로 끝내고 화면 이름을 찾아 실패 메일을 보낸다', async () => {
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.excelDownloadLog.findMany.mockResolvedValue([
        job({ attemptCount: 2 }),
      ]);
      await service.processPending(NOW);
      expect(prisma.excelDownloadLog.updateMany).toHaveBeenCalledWith({
        where: { excelDownloadId: 31, status: 'PROCESSING', attemptCount: 2 },
        data: { status: 'FAILED', failureReason: '생성 중 서버가 멈췄다' },
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'EMAIL_EXCEL_FAILED',
          variables: expect.objectContaining({ 화면: 'BP 목록' }),
        }),
      );
    });

    it('실패 기록이 0행이면(다른 시도가 가져감) 실패 메일을 보내지 않는다', async () => {
      prisma.excelDownloadLog.findUnique.mockResolvedValue(
        job({ attemptCount: 2 }),
      );
      source.build.mockRejectedValue(new Error('boom'));
      prisma.excelDownloadLog.updateMany.mockResolvedValue({ count: 0 });
      await service.processPending(NOW);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('멈춘 작업은 이번 시도를 시작한 시각으로 판단한다 — 오래 기다린 작업이 막 시작하자마자 빼앗기지 않게', async () => {
      await service.processPending(NOW);
      const [stuck] = prisma.excelDownloadLog.findMany.mock.calls[0];
      expect(stuck.where).toEqual({
        deliveryMethod: 'SCHEDULED',
        status: 'PROCESSING',
        startedAt: { lte: new Date(NOW.getTime() - HOUR) },
      });
      // 호출 순서가 아니라 바로 받기 정리 호출을 골라 본다
      const [direct] = prisma.excelDownloadLog.updateMany.mock.calls.find(
        ([arg]) => arg.where.deliveryMethod === 'DIRECT',
      );
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

    it('만들지 못했으면 409 「다시 요청」, 저장소가 없으면 503 — 받은 시각을 남기지 않는다', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({ status: 'FAILED' }),
      );
      await expect(service.download(7, 31, NOW)).rejects.toThrow(
        '엑셀 파일을 만들지 못했습니다. 다시 요청해 주세요',
      );
      const registry = new ExcelExportRegistry();
      const noStorage = new ExcelExportsService(prisma, registry, null, mail, {
        get: () => 'https://admin.example.com',
      } as unknown as ConfigService);
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({
          status: 'SUCCEEDED',
          storageKey: 'excel-exports/7/a.xlsx',
          expiresAt: new Date(NOW.getTime() + HOUR),
        }),
      );
      await expect(noStorage.download(7, 31, NOW)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.excelDownloadLog.update).not.toHaveBeenCalled();
    });

    // 파일은 24시간 받을 수 있다 — 만든 뒤 권한을 잃거나 계정이 막혔으면 받지 못한다(만들 때만 보면 그 사이가 열린다).
    it('받을 때 그 화면의 조회 권한을 다시 본다 — 잃었으면 403 이고 주소를 주지 않는다', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({
          status: 'SUCCEEDED',
          storageKey: 'excel-exports/7/a.xlsx',
          expiresAt: new Date(NOW.getTime() + HOUR),
        }),
      );
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      await expect(service.download(7, 31, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(storage.downloadUrl).not.toHaveBeenCalled();
      expect(prisma.excelDownloadLog.update).not.toHaveBeenCalled();
    });

    it('받을 때 화면의 호출자 검사도 부른다(예: BP 목록은 지금도 플랫폼 계정이어야 한다)', async () => {
      prisma.excelDownloadLog.findFirst.mockResolvedValueOnce(
        job({
          status: 'SUCCEEDED',
          storageKey: 'excel-exports/7/a.xlsx',
          expiresAt: new Date(NOW.getTime() + HOUR),
        }),
      );
      source.assertRequester.mockRejectedValueOnce(
        new ForbiddenException('플랫폼 계정이 아님'),
      );
      await expect(service.download(7, 31, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(source.assertRequester).toHaveBeenCalledWith(7);
      expect(storage.downloadUrl).not.toHaveBeenCalled();
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
