import { randomInt } from 'node:crypto';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { unzipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { BATCH_JOB } from '../src/batch/batch-job-names';
import { BatchLockService } from '../src/batch/batch-lock.service';
import { BulkExportsService } from '../src/bulk-exports/bulk-exports.service';
import type {
  BulkExportItemDto,
  BulkExportListResponseDto,
  BulkExportPreviewResponseDto,
} from '../src/bulk-exports/dto/bulk-export.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';

// 직원 자료 일괄 저장(WHALEERP-336)을 실제 DB 로 확인한다 — 권한 유형 · 범위 · 부분 고유 인덱스 · 배열 포함(<@) 목록 ·
// 내려받기 이력 · 기한 정리는 목으로 증명되지 않는다. S3 는 가짜로 바꾼다.
describe('직원 자료 일괄 저장 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_999);
  const code = (k: number) => String((n + k) % 1_000_000).padStart(6, '0');
  let bpCodeId: number;
  let otherBpId: number;
  const store: Record<string, number> = {};
  const admin: Record<string, number> = {};
  const staff: Record<string, number> = {};
  const accountIds: number[] = [];
  const contractIds: number[] = [];
  const storage = {
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 계약서')),
    downloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    // 진짜 크론을 세운다 — 테스트가 processPending 을 부르기 전에 가져가면 결과가 흔들린다
    const scheduler = app.get(SchedulerRegistry);
    await scheduler.getCronJob(BATCH_JOB.BULK_EXPORT).stop();
    await scheduler.getCronJob(BATCH_JOB.BULK_EXPORT_FILE_PURGE).stop();
    prisma = app.get(PrismaService);

    const bp = (k: number, tradeName: string) =>
      prisma.bpCode.create({
        data: {
          bpCode: `BP${code(k)}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName,
        },
      });
    ({ bpCodeId } = await bp(0, '일괄 저장 BP'));
    ({ bpCodeId: otherBpId } = await bp(1, '다른 BP'));
    const mkStore = async (
      key: string,
      k: number,
      bpId: number,
      storeTypeCode: string,
      storeStatusCode = 'OPERATING',
    ) => {
      store[key] = (
        await prisma.store.create({
          data: {
            storeCode: `ST${code(k)}`,
            bpCodeId: bpId,
            storeTypeCode,
            name: `${key}점`,
            storeStatusCode,
          },
        })
      ).storeId;
    };
    await mkStore('직영', 0, bpCodeId, 'DIRECT');
    await mkStore('가맹', 1, bpCodeId, 'FRANCHISE');
    await mkStore('폐점가맹', 2, bpCodeId, 'FRANCHISE', 'CLOSED');
    await mkStore('다른', 3, otherBpId, 'DIRECT');

    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const mkAdmin = async (
      key: string,
      roleTypeCode: string,
      roleCode: string,
      extra: object,
    ) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId: `bulk${key.toLowerCase()}${n}`,
          name: `관리자${key}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId: await roleGroupId(roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: false,
          ...extra,
        },
      });
      admin[key] = a.adminAccountId;
      tokens[key] = (
        await app
          .get(AdminSessionService)
          .issue({ adminAccountId: a.adminAccountId }, (sid) =>
            app.get(JwtService).signAsync({
              sub: a.adminAccountId,
              type: 'admin',
              loginId: a.loginId,
              typ: 'access',
              sid,
            }),
          )
      ).accessToken;
    };
    await mkAdmin('BM', 'BM', 'BM000001', { isAllStores: true });
    await mkAdmin('BM2', 'BM', 'BM000001', { isAllStores: true });
    await mkAdmin('BA', 'BA', 'BM000001', { isAllStores: true });
    await mkAdmin('FM', 'FM', 'FM000001', {
      storeMappings: { create: { storeId: store['가맹'] } },
    });
    await mkAdmin('FA', 'FA', 'FM000001', {
      storeMappings: { create: { storeId: store['가맹'] } },
    });

    const mkAccount = async (consented: boolean) => {
      const phone = `010${randomInt(10_000_000, 99_999_999)}`;
      const a = await prisma.account.create({
        data: {
          email: `bulk-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '일괄',
          birthDate: new Date('1990-01-01'),
          phone,
          status: 'JOINED',
          ...(consented && {
            isHqSharingConsented: true,
            hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
            hqSharingAgreedAt: new Date(),
          }),
        },
      });
      accountIds.push(a.accountId);
      return a.accountId;
    };
    const mkStaff = async (
      key: string,
      storeKey: string,
      contractStatus: 'SIGNED' | 'DRAFT',
      extra: object = {},
    ) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId: store[storeKey],
          name: key,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          ...extra,
        },
      });
      staff[key] = s.staffMemberId;
      const c = await prisma.contract.create({
        data: {
          staffMemberId: s.staffMemberId,
          storeId: store[storeKey],
          createdBy: admin.BM,
          status: contractStatus,
          startDate: new Date('2026-01-01'),
        },
      });
      contractIds.push(c.contractId);
      return c.contractId;
    };
    const signed = await mkStaff('재직', '직영', 'SIGNED');
    await prisma.contractDocument.createMany({
      data: [
        {
          contractId: signed,
          kind: 'SIGNED_COPY',
          storageKey: `contracts/${signed}/0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f.pdf`,
          fileName: 'a.pdf',
          checksum: 'x',
          // 보낸 원본 · 처리 완료본은 어느 발송의 것인지 있어야 한다(CHECK, WHALEERP-131)
          sentAt: new Date(),
        },
        {
          contractId: signed,
          kind: 'SENT_ORIGINAL',
          storageKey: `contracts/${signed}/1b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f.pdf`,
          fileName: 'b.pdf',
          checksum: 'x',
          sentAt: new Date(),
        },
      ],
    });
    await mkStaff('오래된퇴직', '직영', 'SIGNED', {
      employmentStatus: 'RETIRED',
      retiredDate: new Date('2020-01-01'),
    });
    await mkStaff('임시저장만', '직영', 'DRAFT');
    await mkStaff('동의', '가맹', 'SIGNED', {
      accountId: await mkAccount(true),
    });
    await mkStaff('미동의', '가맹', 'SIGNED', {
      accountId: await mkAccount(false),
    });
    await mkStaff('폐점동의', '폐점가맹', 'SIGNED', {
      accountId: await mkAccount(true),
    });
    // 폐점 가맹 점포만 고르면 BP 마스터에게는 담을 직원이 없다
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      const byBp = { bulkExport: { bpCodeId } };
      await prisma.bulkExportDownloadLog.deleteMany({ where: byBp });
      await prisma.bulkExport.deleteMany({ where: { bpCodeId } });
      await prisma.contractDocument.deleteMany({
        where: { contractId: { in: contractIds } },
      });
      await prisma.contract.deleteMany({
        where: { contractId: { in: contractIds } },
      });
      await prisma.staffMember.deleteMany({
        where: { staffMemberId: { in: Object.values(staff) } },
      });
      await prisma.authSession.deleteMany({
        where: { accountId: { in: accountIds } },
      });
      await prisma.account.deleteMany({
        where: { accountId: { in: accountIds } },
      });
      const admins = { adminAccountId: { in: Object.values(admin) } };
      await prisma.adminStoreMapping.deleteMany({ where: admins });
      await prisma.adminSession.deleteMany({ where: admins });
      await prisma.adminAccount.deleteMany({ where: admins });
      await prisma.store.deleteMany({
        where: { storeId: { in: Object.values(store) } },
      });
      await prisma.bpCode.deleteMany({
        where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
      });
    }
    await app?.close();
  });

  const call = (
    who: string,
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${tokens[who]}`);
    return body ? req.send(body) : req;
  };

  it('BP 관리자 · 가맹관리자는 403 — 메뉴 조회 권한이 있어도', async () => {
    for (const who of ['BA', 'FA']) {
      const res = await call(who, 'get', '/staff-members/bulk-exports/preview');
      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        '일괄 저장은 BP 마스터와 가맹마스터만 요청할 수 있습니다.',
      );
      expect(
        (await call(who, 'post', '/staff-members/bulk-exports', {})).status,
      ).toBe(403);
      expect(
        (await call(who, 'get', '/staff-members/bulk-exports')).status,
      ).toBe(403);
    }
  });

  it('직원 앱 토큰은 403', async () => {
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId: accountIds[0], deviceIdentifier: 'bulk-e2e' });
    const token = await app.get(JwtService).signAsync({
      sub: accountIds[0],
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
    const res = await request(app.getHttpServer())
      .get('/staff-members/bulk-exports')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('미리 보기 — BP 마스터는 동의하지 않은 가맹 직원 · 폐점 가맹 점포 직원 · 3년 지난 퇴직자 · 임시저장만 있는 직원을 빼고 센다', async () => {
    const res = await call('BM', 'get', '/staff-members/bulk-exports/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      storeCount: 3,
      staffCount: 2, // 재직 · 동의
      employedCount: 2,
      retiredCount: 0,
      inProgress: false,
    });
  });

  it('미리 보기 — 가맹마스터는 동의로 가리지 않는다. storeIds 는 반복 · 쉼표 둘 다 받는다', async () => {
    const id = store['가맹'];
    for (const q of [
      `storeIds=${id}`,
      `storeIds=${id}&storeIds=${id}`,
      `storeIds=${id},${id}`,
    ]) {
      const res = await call(
        'FM',
        'get',
        `/staff-members/bulk-exports/preview?${q}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ storeCount: 1, staffCount: 2 });
    }
  });

  it('관리하지 않는 점포가 섞이면 400', async () => {
    expect(
      (
        await call(
          'BM',
          'get',
          `/staff-members/bulk-exports/preview?storeIds=${store['다른']}`,
        )
      ).status,
    ).toBe(400);
    const res = await call('FM', 'post', '/staff-members/bulk-exports', {
      storeIds: [store['가맹'], store['직영']],
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      '업무 범위 밖의 점포가 있습니다.',
    );
  });

  it('담을 직원이 없으면 400 — 폐점 가맹 점포만 고른 BP 마스터', async () => {
    const res = await call('BM', 'post', '/staff-members/bulk-exports', {
      storeIds: [store['폐점가맹']],
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      '업무 범위에 담을 직원 자료가 없습니다.',
    );
  });

  describe('요청 → 만들기 → 내려받기 → 기한', () => {
    let bulkExportId: number;

    it('요청은 201 · 대기, 같은 범위를 다시 요청하면 409', async () => {
      const res = await call('BM', 'post', '/staff-members/bulk-exports', {});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        requesterName: '관리자BM',
        storeIds: [store['직영'], store['가맹'], store['폐점가맹']].sort(
          (x, y) => x - y,
        ),
        staffCount: 2,
        status: 'PENDING',
        completedAt: null,
        expiresAt: null,
        isExpired: false,
        failureReason: null,
      });
      bulkExportId = (res.body as BulkExportItemDto).bulkExportId;
      const again = await call(
        'BM2',
        'post',
        '/staff-members/bulk-exports',
        {},
      );
      expect(again.status).toBe(409);
      expect((again.body as { message: string }).message).toBe(
        '같은 업무 범위의 일괄 저장 파일을 만들고 있습니다.',
      );
      const preview = await call(
        'BM',
        'get',
        '/staff-members/bulk-exports/preview',
      );
      expect((preview.body as BulkExportPreviewResponseDto).inProgress).toBe(
        true,
      );
    });

    it('목록 — 같은 BP 의 다른 BP 마스터도 보고, 가맹마스터는 보지 않는다. /staff-members/:id 에 먹히지 않는다', async () => {
      const bm2 = await call('BM2', 'get', '/staff-members/bulk-exports');
      expect(bm2.status).toBe(200);
      const page = bm2.body as BulkExportListResponseDto;
      expect(page.total).toBe(1);
      expect(page.items[0].bulkExportId).toBe(bulkExportId);
      const fm = await call('FM', 'get', '/staff-members/bulk-exports');
      expect(fm.body).toEqual({ items: [], total: 0 });
    });

    it('만드는 중이면 내려받기 409, 볼 수 없는 사람은 404', async () => {
      expect(
        (
          await call(
            'BM',
            'post',
            `/staff-members/bulk-exports/${bulkExportId}/download`,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            'FM',
            'post',
            `/staff-members/bulk-exports/${bulkExportId}/download`,
          )
        ).status,
      ).toBe(404);
    });

    it('배치가 zip 을 만든다 — 처리 완료본은 담고 발송 원본은 담지 않는다', async () => {
      expect(await app.get(BulkExportsService).processPending()).toBe(1);
      const row = await prisma.bulkExport.findUniqueOrThrow({
        where: { bulkExportId },
      });
      expect(row.failureReason).toBeNull();
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        staffCount: 2,
        attemptCount: 1,
      });
      expect([...row.staffMemberIds].sort((x, y) => x - y)).toEqual(
        [staff['재직'], staff['동의']].sort((x, y) => x - y),
      );
      expect(row.storageKey).toMatch(
        new RegExp(`^bulk-exports/${bpCodeId}/.+\\.zip$`),
      );
      expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(
        7 * 86_400_000,
      );
      const [key, buffer, kind] = storage.put.mock.calls[0] as [
        string,
        Buffer,
        string,
      ];
      expect([key, kind]).toEqual([row.storageKey, 'ZIP']);
      const paths = Object.keys(unzipSync(buffer));
      expect(paths).toEqual(
        expect.arrayContaining([
          '근로계약_목록.csv',
          '출퇴근_기록.csv',
          `직영점/재직_${staff['재직']}/근로계약서/${contractIds[0]}_날인 완료본.pdf`,
        ]),
      );
      expect(paths.filter((p) => p.includes('근로계약서/'))).toHaveLength(1);
      expect(storage.get).toHaveBeenCalledTimes(1);
      const csv = Buffer.from(
        unzipSync(buffer)['근로계약_목록.csv'],
      ).toString();
      expect(csv).toContain('동의');
      expect(csv).not.toContain('미동의');
      expect(csv).not.toContain('폐점동의');
    });

    it('내려받기 — 같은 BP 의 다른 BP 마스터도 받고, 이력을 남긴다', async () => {
      const res = await call(
        'BM2',
        'post',
        `/staff-members/bulk-exports/${bulkExportId}/download`,
      );
      expect(res.status).toBe(200);
      const link = res.body as { url: string; fileName: string };
      expect(link.url).toBe('https://s3.example.com/signed');
      expect(link.fileName).toMatch(/^직원자료_일괄 저장 BP_\d{8}\.zip$/);
      const logs = await prisma.bulkExportDownloadLog.findMany({
        where: { bulkExportId },
      });
      expect(logs.map((l) => l.downloadedBy)).toEqual([admin.BM2]);
    });

    it('만든 뒤 담긴 직원이 동의를 철회하거나 가맹 점포가 폐점하면 BP 마스터 내려받기는 409 — 가맹마스터 파일은 보지 않는다', async () => {
      const download = (who: string, id: number) =>
        call(who, 'post', `/staff-members/bulk-exports/${id}/download`);
      const { accountId } = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: staff['동의'] },
      });
      const consent = (isHqSharingConsented: boolean) =>
        prisma.account.update({
          where: { accountId: accountId! },
          data: isHqSharingConsented
            ? {
                isHqSharingConsented,
                hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
                hqSharingAgreedAt: new Date(),
              }
            : {
                isHqSharingConsented,
                hqSharingConsentVersion: null,
                hqSharingAgreedAt: null,
              },
        });
      const storeStatus = (storeStatusCode: string) =>
        prisma.store.update({
          where: { storeId: store['가맹'] },
          data: { storeStatusCode },
        });
      try {
        await consent(false);
        const res = await download('BM', bulkExportId);
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toBe(
          '파일을 만든 뒤 담긴 직원의 동의나 점포 상태가 바뀌었습니다. 다시 요청해 주세요.',
        );
        // 가맹마스터 파일은 동의로 거르지 않아 다시 보지 않는다
        const now = new Date();
        const fmRow = await prisma.bulkExport.create({
          data: {
            bpCodeId,
            requestedBy: admin.FM,
            roleTypeCode: 'FM',
            storeIds: [store['가맹']],
            scopeKey: `FM:${store['가맹']}`,
            status: 'SUCCEEDED',
            staffCount: 2,
            staffMemberIds: [staff['동의'], staff['미동의']],
            storageKey: `bulk-exports/${bpCodeId}/fm.zip`,
            fileName: 'fm.zip',
            completedAt: now,
            expiresAt: new Date(now.getTime() + 86_400_000),
          },
        });
        expect((await download('FM', fmRow.bulkExportId)).status).toBe(200);
        await consent(true);
        await storeStatus('CLOSED');
        expect((await download('BM', bulkExportId)).status).toBe(409);
      } finally {
        await consent(true);
        await storeStatus('OPERATING');
      }
      expect((await download('BM', bulkExportId)).status).toBe(200);
    });

    it('기한이 지나면 매일 정리가 파일을 지우고 storage_key 를 비운다 — 그 뒤 내려받기는 410', async () => {
      const { storageKey } = await prisma.bulkExport.update({
        where: { bulkExportId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (
          await call(
            'BM',
            'post',
            `/staff-members/bulk-exports/${bulkExportId}/download`,
          )
        ).status,
      ).toBe(410);
      await app
        .get(BatchLockService)
        .runExclusive(BATCH_JOB.BULK_EXPORT_FILE_PURGE, (tx) =>
          app.get(BulkExportsService).purgeExpiredFiles(tx),
        );
      expect(storage.delete).toHaveBeenCalledWith(storageKey);
      const row = await prisma.bulkExport.findUniqueOrThrow({
        where: { bulkExportId },
      });
      expect(row.storageKey).toBeNull();
      const res = await call(
        'BM',
        'post',
        `/staff-members/bulk-exports/${bulkExportId}/download`,
      );
      expect(res.status).toBe(410);
      expect((res.body as { message: string }).message).toBe(
        '받을 수 있는 기한이 지났습니다.',
      );
      const list = await call('BM', 'get', '/staff-members/bulk-exports');
      expect((list.body as BulkExportListResponseDto).items[0]).toMatchObject({
        isExpired: true,
      });
    });
  });

  describe('만들기 — 인덱스 · 실패 사유 · 멈춘 작업', () => {
    const clear = async () => {
      await prisma.bulkExportDownloadLog.deleteMany({
        where: { bulkExport: { bpCodeId } },
      });
      await prisma.bulkExport.deleteMany({ where: { bpCodeId } });
    };
    beforeEach(async () => {
      await clear();
      jest.clearAllMocks();
      storage.get.mockResolvedValue(Buffer.from('%PDF-1.7 계약서'));
    });
    const row = (over: object = {}) => ({
      bpCodeId,
      requestedBy: admin.BM,
      roleTypeCode: 'BM',
      storeIds: [store['직영']],
      scopeKey: `BM:${store['직영']}`,
      staffCount: 1,
      fileName: 'x.zip',
      ...over,
    });

    it('점포가 수백 개인 긴 범위 키도 받고, 만드는 중이면 두 번째 행은 부분 고유 인덱스가 막는다(P2002)', async () => {
      // btree 한 행 한도(약 2.7KB)를 넘는 키 — md5 로 묶지 않으면 첫 행부터 들어가지 않는다
      const scopeKey = `BM:${Array.from({ length: 800 }, (_, i) => i + 1).join(',')}`;
      expect(scopeKey.length).toBeGreaterThan(3000);
      await prisma.bulkExport.create({ data: row({ scopeKey }) });
      await expect(
        prisma.bulkExport.create({ data: row({ scopeKey }) }),
      ).rejects.toMatchObject({ code: 'P2002' });
      // 끝난 요청은 막지 않는다
      await prisma.bulkExport.updateMany({
        where: { bpCodeId },
        data: { status: 'FAILED' },
      });
      await expect(
        prisma.bulkExport.create({ data: row({ scopeKey }) }),
      ).resolves.toBeDefined();
    });

    it('같은 범위를 동시에 두 번 요청해도 행은 하나, 나머지는 409', async () => {
      const statuses = await Promise.all([
        call('BM', 'post', '/staff-members/bulk-exports', {}),
        call('BM2', 'post', '/staff-members/bulk-exports', {}),
      ]).then((rs) => rs.map((r) => r.status).sort());
      expect(statuses).toEqual([201, 409]);
      expect(await prisma.bulkExport.count({ where: { bpCodeId } })).toBe(1);
    });

    it('S3 오류는 다시 시도하고, 화면 사유에는 원문 대신 공통 문구만 남긴다', async () => {
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row(),
      });
      storage.get.mockRejectedValueOnce(
        new Error('AccessDenied arn:aws:s3:::whale-erp-files/secret'),
      );
      const service = app.get(BulkExportsService);

      await service.processPending();
      const first = await prisma.bulkExport.findUniqueOrThrow({
        where: { bulkExportId },
      });
      expect(first).toMatchObject({
        status: 'PENDING',
        attemptCount: 1,
        failureReason:
          '일괄 저장 파일을 만들지 못했습니다. 다시 요청해 주세요.',
      });

      await service.processPending();
      expect(
        await prisma.bulkExport.findUniqueOrThrow({ where: { bulkExportId } }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        attemptCount: 2,
        failureReason: null,
      });
    });

    it('저장소가 없다고 답한 계약서 파일은 건너뛰고 누락_파일.csv 에 적어 완료한다', async () => {
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row(),
      });
      storage.get.mockRejectedValueOnce(
        Object.assign(new Error('NoSuchKey'), {
          $metadata: { httpStatusCode: 404 },
        }),
      );
      await app.get(BulkExportsService).processPending();
      expect(
        await prisma.bulkExport.findUniqueOrThrow({ where: { bulkExportId } }),
      ).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
      const [, buffer] = storage.put.mock.calls[0] as [string, Buffer];
      const files = unzipSync(buffer);
      expect(Object.keys(files).some((p) => p.includes('근로계약서/'))).toBe(
        false,
      );
      const csv = Buffer.from(files['누락_파일.csv']).toString();
      expect(csv).toContain(`재직`);
      expect(csv).toContain(String(contractIds[0]));
      expect(csv).toContain('날인 완료본');
    });

    it('올려 둔 키가 있는 채 멈춘 작업은 정리하면서 그 파일을 지운다 — 개인 자료 zip 이 버킷에 남지 않게', async () => {
      const now = new Date();
      const storageKey = `bulk-exports/${bpCodeId}/0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f.zip`;
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row({
          status: 'PROCESSING',
          attemptCount: 2,
          startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
          storageKey,
        }),
      });
      await app.get(BulkExportsService).processPending(now);
      expect(storage.delete).toHaveBeenCalledWith(storageKey);
      expect(
        await prisma.bulkExport.findUniqueOrThrow({ where: { bulkExportId } }),
      ).toMatchObject({ status: 'FAILED', storageKey: null });
    });

    it('요청자가 그 권한 유형 · 범위를 더 이상 관리하지 않으면 다시 시도하지 않고 바로 실패 — 사유는 내려받기에도 그대로', async () => {
      // 가맹마스터가 BP 마스터 범위의 요청자인 행 — 만들 때 다시 보는 권한 확인(requesterStores)이 403 을 낸다
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row({ requestedBy: admin.FM }),
      });
      await app.get(BulkExportsService).processPending();
      const failed = await prisma.bulkExport.findUniqueOrThrow({
        where: { bulkExportId },
      });
      const reason =
        '요청한 관리자가 이 업무 범위를 더 이상 관리하지 않아 파일을 만들지 않았습니다.';
      expect(failed).toMatchObject({
        status: 'FAILED',
        attemptCount: 1,
        failureReason: reason,
      });
      expect(storage.put).not.toHaveBeenCalled();
      const res = await call(
        'BM',
        'post',
        `/staff-members/bulk-exports/${bulkExportId}/download`,
      );
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(reason);
    });

    it('마지막 시도에서 멈춘 작업은 다시 집지 않고 실패로 끝낸다', async () => {
      const now = new Date();
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row({
          status: 'PROCESSING',
          attemptCount: 2,
          startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        }),
      });
      expect(await app.get(BulkExportsService).processPending(now)).toBe(0);
      expect(
        await prisma.bulkExport.findUniqueOrThrow({ where: { bulkExportId } }),
      ).toMatchObject({ status: 'FAILED', attemptCount: 2 });
    });

    it('만드는 중으로 멈춘 작업은 대기로 돌아가 다시 집혀 만들어진다', async () => {
      const now = new Date();
      const { bulkExportId } = await prisma.bulkExport.create({
        data: row({
          status: 'PROCESSING',
          attemptCount: 1,
          startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        }),
      });

      expect(await app.get(BulkExportsService).processPending(now)).toBe(1);

      const done = await prisma.bulkExport.findUniqueOrThrow({
        where: { bulkExportId },
      });
      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });
      // 다시 집은 시각은 배치에 넘긴 now 다
      expect(done.startedAt).toEqual(now);
    });
  });
});
