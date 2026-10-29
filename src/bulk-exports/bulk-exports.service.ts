import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type BulkExport } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { DETAIL_SELECT, toSummary } from '../payslips/my-payslips.service';
import { payslipPdfModel, renderPayslipPdf } from '../payslips/payslip-pdf';
import { dateOnly, storeNames } from '../payslips/payslip-shared';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, type OptionalStorage } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { archivePlan, zipArchive } from './bulk-export-archive';
import {
  BULK_EXPORT_MAX_ATTEMPTS,
  BULK_EXPORT_MAX_BYTES,
  BULK_EXPORT_ROLES,
  BULK_EXPORT_TTL_MS,
  bulkExportFileName,
  isVisibleTo,
  resolveStoreIds,
  scopeKeyOf,
  targetStaffWhere,
  TOO_LARGE_MESSAGE,
  visibleStaffWhere,
  type ScopeStore,
} from './bulk-export-policy';
import type {
  BulkExportDownloadResponseDto,
  BulkExportItemDto,
  BulkExportListResponseDto,
  BulkExportPreviewResponseDto,
} from './dto/bulk-export.dto';

export const ROLE_DENIED_MESSAGE =
  '일괄 저장은 BP 마스터와 가맹마스터만 요청할 수 있습니다.';
const OUT_OF_SCOPE_MESSAGE = '업무 범위 밖의 점포가 있습니다.';
const NO_STAFF_MESSAGE = '업무 범위에 담을 직원 자료가 없습니다.';
const BUSY_MESSAGE = '같은 업무 범위의 일괄 저장 파일을 만들고 있습니다.';
const NOT_FOUND_MESSAGE = '일괄 저장 파일을 찾을 수 없습니다.';
const FAILED_MESSAGE =
  '일괄 저장 파일을 만들지 못했습니다. 다시 요청해 주세요.';
const EXPIRED_MESSAGE = '받을 수 있는 기한이 지났습니다.';
const NO_STORAGE_MESSAGE = '지금은 일괄 저장 파일을 만들 수 없습니다.';
export const CHANGED_MESSAGE =
  '파일을 만든 뒤 담긴 직원의 동의나 점포 상태가 바뀌었습니다. 다시 요청해 주세요.';

// 계약서에 담는 파일 — 처리 완료본 · 종이 계약 날인본. 발송 원본 · 서명 그림은 담지 않는다.
const DOCUMENT_KINDS = [
  'SIGNED_COPY',
  'PAPER_EMPLOYMENT_CONTRACT',
  'WAGE_CONTRACT',
] as const;
/** 한 틱에 만드는 수 — zip 은 무겁다. 남은 것은 다음 분에 */
const PROCESS_LIMIT = 2;
/** 만드는 중으로 이만큼 남으면 서버가 그 사이 죽은 것으로 본다 */
const STUCK_MS = 60 * 60_000;
const REASON_MAX = 1_000;
const IN_PROGRESS = ['PENDING', 'PROCESSING'] as const;

interface Viewer {
  adminAccountId: number;
  bpCodeId: number;
  roleTypeCode: string;
  stores: ScopeStore[];
}

/**
 * 직원 자료 일괄 저장(WHALEERP-336, 계획 docs/plans/2026-10-29-staff-records-export.md). 1팀 공통 엑셀(excel-exports)의 방식 —
 * 1분 배치가 SKIP LOCKED 로 집기 · 멈춘 작업 되살리기 · 낙관적 마무리 · 부분 고유 인덱스 — 을 따른다. 알림 · 메일은 없다
 * (NTF-01). 상태는 일괄 저장 화면에서만 본다.
 */
@Injectable()
export class BulkExportsService {
  private readonly logger = new Logger(BulkExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  async preview(
    adminAccountId: number,
    storeIds?: number[],
    now: Date = new Date(),
  ): Promise<BulkExportPreviewResponseDto> {
    const viewer = await this.viewer(adminAccountId);
    const ids = this.scopeIds(viewer, storeIds);
    const groups = await this.prisma.staffMember.groupBy({
      by: ['employmentStatus'],
      where: targetStaffWhere(viewer.roleTypeCode, storesOf(viewer, ids), now),
      _count: { _all: true },
    });
    const countOf = (s: string) =>
      groups.find((g) => g.employmentStatus === s)?._count._all ?? 0;
    const inProgress = ids.length
      ? (await this.prisma.bulkExport.count({
          where: {
            bpCodeId: viewer.bpCodeId,
            scopeKey: scopeKeyOf(viewer.roleTypeCode, ids),
            status: { in: [...IN_PROGRESS] },
          },
        })) > 0
      : false;
    const employedCount = countOf('EMPLOYED');
    const retiredCount = countOf('RETIRED');
    return {
      storeCount: ids.length,
      staffCount: employedCount + retiredCount,
      employedCount,
      retiredCount,
      inProgress,
    };
  }

  /** 요청. 같은 범위가 만드는 중이면 409 — 앱이 먼저 보고, 동시에 들어오면 부분 고유 인덱스가 하나만 남긴다(P2002 → 409). */
  async request(
    adminAccountId: number,
    storeIds?: number[],
    now: Date = new Date(),
  ): Promise<BulkExportItemDto> {
    const viewer = await this.viewer(adminAccountId);
    const ids = this.scopeIds(viewer, storeIds);
    const staffCount = await this.prisma.staffMember.count({
      where: targetStaffWhere(viewer.roleTypeCode, storesOf(viewer, ids), now),
    });
    if (!staffCount) throw new BadRequestException(NO_STAFF_MESSAGE);
    if (!this.storage)
      throw new ServiceUnavailableException(NO_STORAGE_MESSAGE);
    const scopeKey = scopeKeyOf(viewer.roleTypeCode, ids);
    const busy = await this.prisma.bulkExport.count({
      where: {
        bpCodeId: viewer.bpCodeId,
        scopeKey,
        status: { in: [...IN_PROGRESS] },
      },
    });
    if (busy) throw new ConflictException(BUSY_MESSAGE);
    const bp = await this.prisma.bpCode.findUniqueOrThrow({
      where: { bpCodeId: viewer.bpCodeId },
      select: { tradeName: true },
    });
    const row = await this.prisma.bulkExport
      .create({
        data: {
          bpCodeId: viewer.bpCodeId,
          requestedBy: adminAccountId,
          roleTypeCode: viewer.roleTypeCode,
          storeIds: ids,
          scopeKey,
          staffCount,
          fileName: bulkExportFileName(bp.tradeName, now),
          requestedAt: now,
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw new ConflictException(BUSY_MESSAGE);
        throw error;
      });
    return (await this.items([row], now))[0];
  }

  /** 볼 수 있는 요청(isVisibleTo — 같은 BP · 같은 권한 유형 · 요청의 점포를 모두 관리), 최근 순 */
  async list(
    adminAccountId: number,
    page = 1,
    pageSize = 20,
    now: Date = new Date(),
  ): Promise<BulkExportListResponseDto> {
    const viewer = await this.viewer(adminAccountId);
    const managed = viewer.stores.map((s) => s.storeId);
    // 「요청의 점포를 모두 관리」는 배열 포함(<@)이라 Prisma where 로 쓰지 못한다 — isVisibleTo 와 같은 규칙을 SQL 로
    const visible = Prisma.sql`"bp_code_id" = ${viewer.bpCodeId}
         AND "role_type_code" = ${viewer.roleTypeCode}
         AND "store_ids" <@ ${managed}::int[]`;
    const [{ total }] = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM "bulk_exports" WHERE ${visible}`;
    const ids = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT "bulk_export_id" AS id FROM "bulk_exports" WHERE ${visible}
       ORDER BY "requested_at" DESC, "bulk_export_id" DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const rows = await this.prisma.bulkExport.findMany({
      where: { bulkExportId: { in: ids.map((r) => r.id) } },
      orderBy: [{ requestedAt: 'desc' }, { bulkExportId: 'desc' }],
    });
    return { items: await this.items(rows, now), total };
  }

  /** 완료이고 기한 안이면 5분짜리 주소를 주고 이력을 남긴다. 아직이면 409, 기한이 지났으면 410, 볼 수 없으면 404 */
  async download(
    adminAccountId: number,
    bulkExportId: number,
    now: Date = new Date(),
  ): Promise<BulkExportDownloadResponseDto> {
    const viewer = await this.viewer(adminAccountId);
    const row = await this.prisma.bulkExport.findUnique({
      where: { bulkExportId },
    });
    if (
      !row ||
      !isVisibleTo(row, {
        ...viewer,
        storeIds: viewer.stores.map((s) => s.storeId),
      })
    )
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (row.status !== 'SUCCEEDED')
      throw new ConflictException(
        row.status === 'FAILED'
          ? (row.failureReason ?? FAILED_MESSAGE)
          : BUSY_MESSAGE,
      );
    if (!row.storageKey || !row.expiresAt || row.expiresAt <= now)
      throw new GoneException(EXPIRED_MESSAGE);
    if (!this.storage)
      throw new ServiceUnavailableException(NO_STORAGE_MESSAGE);
    // BP 마스터 파일은 만든 뒤 동의 철회 · 가맹 폐점이 생겼으면 막는다(2026-10-29 재영, RET-09). 가맹마스터 파일은 동의로 거르지 않는다
    if (row.roleTypeCode === 'BM' && row.staffMemberIds.length) {
      const still = await this.prisma.staffMember.count({
        where: {
          AND: [
            { staffMemberId: { in: row.staffMemberIds } },
            visibleStaffWhere('BM', storesOf(viewer, row.storeIds)),
          ],
        },
      });
      if (still < row.staffMemberIds.length)
        throw new ConflictException(CHANGED_MESSAGE);
    }
    const url = await this.storage.downloadUrl(row.storageKey, row.fileName);
    await this.prisma.bulkExportDownloadLog.create({
      data: { bulkExportId, downloadedBy: adminAccountId, downloadedAt: now },
    });
    return {
      url,
      fileName: row.fileName,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** 배치 한 번 — 멈춘 작업을 되살리고, 대기 중인 것을 하나씩 집어 만든다. 처리한 수 */
  async processPending(now: Date = new Date()): Promise<number> {
    await this.recoverStuck(now);
    const handled: number[] = [];
    while (handled.length < PROCESS_LIMIT) {
      const job = await this.claim(handled, now);
      if (!job) break;
      handled.push(job.bulkExportId);
      await this.runJob(job).catch((error: unknown) =>
        this.logger.error(
          `bulk export JOB ERROR id=${job.bulkExportId}: ${reasonOf(error)}`,
        ),
      );
    }
    return handled.length;
  }

  /**
   * 기한이 지난 파일을 지우고 storage_key 를 비운다(매일, BatchLockService.runExclusive 안). 한 파일이 실패하면 그 행은 키를
   * 남겨 다음 날 다시 지운다. 지운 수.
   */
  async purgeExpiredFiles(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<number> {
    if (!this.storage) return 0;
    const rows = await tx.bulkExport.findMany({
      where: { storageKey: { not: null }, expiresAt: { lte: now } },
      select: { bulkExportId: true, storageKey: true },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    });
    let deleted = 0;
    for (const { bulkExportId, storageKey } of rows) {
      if (!storageKey) continue;
      try {
        await this.storage.delete(storageKey);
        await tx.bulkExport.update({
          where: { bulkExportId },
          data: { storageKey: null },
        });
        deleted += 1;
      } catch (error) {
        this.logger.error(
          `bulk export file DELETE FAILED id=${bulkExportId}: ${reasonOf(error)}`,
        );
      }
    }
    return deleted;
  }

  /** 범위의 자료를 zip 하나로. 신고 정보 · 확인자료 · 동의 기록 표는 읽지 않는다. */
  async buildArchive(
    roleTypeCode: string,
    stores: ScopeStore[],
    now: Date,
    maxBytes = BULK_EXPORT_MAX_BYTES,
  ): Promise<{ buffer: Buffer; staffMemberIds: number[] }> {
    const storage = this.requireStorage();
    // ponytail: 직원 ID 를 IN 목록 하나로 묻는다 — 한 범위가 수만 명이면 바인드 변수 한도(65535)에 닿는다. 그때 직원을 나눠 읽는다.
    const staff = await this.prisma.staffMember.findMany({
      where: targetStaffWhere(roleTypeCode, stores, now),
      select: { staffMemberId: true, storeId: true, name: true, phone: true },
      orderBy: [{ storeId: 'asc' }, { name: 'asc' }, { staffMemberId: 'asc' }],
    });
    const byStaff = {
      staffMemberId: { in: staff.map((s) => s.staffMemberId) },
    };
    const stores_ = await this.prisma.store.findMany({
      where: { storeId: { in: stores.map((s) => s.storeId) } },
      select: { storeId: true, name: true },
    });
    const contracts = await this.prisma.contract.findMany({
      where: { ...byStaff, status: { not: 'DRAFT' } },
      select: {
        contractId: true,
        staffMemberId: true,
        status: true,
        contractMethod: true,
        employmentType: true,
        jobTitle: true,
        startDate: true,
        endDate: true,
        wageAmount: true,
        sentAt: true,
        contractDocuments: {
          where: { kind: { in: [...DOCUMENT_KINDS] } },
          select: { kind: true, storageKey: true },
          orderBy: { contractDocumentId: 'asc' },
        },
      },
      orderBy: { contractId: 'asc' },
    });
    const attendance = await this.prisma.attendanceRecord.findMany({
      where: byStaff,
      select: {
        attendanceRecordId: true,
        staffMemberId: true,
        kind: true,
        recordedAt: true,
        entryMethod: true,
        proxyBy: true,
        proxyReason: true,
        reviewReason: true,
        attendanceCorrections: {
          select: {
            beforeValue: true,
            afterValue: true,
            reason: true,
            correctedBy: true,
            correctedAt: true,
          },
          orderBy: { correctedAt: 'asc' },
        },
      },
      orderBy: [{ staffMemberId: 'asc' }, { recordedAt: 'asc' }],
    });
    const schedules = await this.prisma.workSchedule.findMany({
      where: { ...byStaff, isDeleted: false },
      select: {
        staffMemberId: true,
        startAt: true,
        endAt: true,
        breakMinutes: true,
      },
      orderBy: [{ staffMemberId: 'asc' }, { startAt: 'asc' }],
    });
    const payslips = await this.prisma.payslip.findMany({
      where: { ...byStaff, status: 'SENT' },
      select: { ...DETAIL_SELECT, staffMemberId: true },
      orderBy: [{ staffMemberId: 'asc' }, { periodStartDate: 'asc' }],
    });
    const adminIds = [
      ...new Set(
        attendance.flatMap((r) => [
          ...(r.proxyBy ? [r.proxyBy] : []),
          ...r.attendanceCorrections.map((c) => c.correctedBy),
        ]),
      ),
    ];
    const admins = adminIds.length
      ? await this.prisma.adminAccount.findMany({
          where: { adminAccountId: { in: adminIds } },
          select: { adminAccountId: true, name: true, loginId: true },
        })
      : [];

    const storeName = new Map(stores_.map((s) => [s.storeId, s.name]));
    const adminById = new Map(admins.map((a) => [a.adminAccountId, a]));
    const plan = archivePlan({
      storeNames: storeName,
      staff,
      contracts: contracts.map(({ contractDocuments, ...c }) => ({
        ...c,
        documents: contractDocuments,
      })),
      attendance: attendance.map(({ attendanceCorrections, ...r }) => ({
        ...r,
        corrections: attendanceCorrections,
      })),
      schedules,
      payslips: payslips.map((p) => ({
        payslipId: p.payslipId,
        staffMemberId: p.staffMemberId,
        periodStartDate: dateOnly(p.periodStartDate),
        periodEndDate: dateOnly(p.periodEndDate),
        employmentType: p.employmentType,
        grossPayAmount: p.grossPayAmount,
        totalDeductionAmount: p.totalDeductionAmount,
        netPayAmount: p.netPayAmount,
        sentAt:
          p.payslipLogs.find((l) => l.logType === 'SEND')?.changedAt ?? null,
      })),
      adminName: (id) => {
        const a = id === null ? undefined : adminById.get(id);
        return a ? (a.name ?? a.loginId) : '-';
      },
    });

    const entries = [...plan.csv].map(([path, data]) => ({ path, data }));
    // 계약서 파일 · 명세서 PDF 를 모두 메모리에 쥔다(zipArchive 의 ponytail) — 한도를 넘으면 다시 해도 같으므로 4xx 로 멈춘다
    let bytes = 0;
    const add = (path: string, data: Buffer) => {
      bytes += data.length;
      if (bytes > maxBytes)
        throw new PayloadTooLargeException(TOO_LARGE_MESSAGE);
      entries.push({ path, data });
    };
    // 차례로 읽는다 — 한꺼번에 받으면 동시 요청 · 메모리가 한 번에 솟는다
    for (const f of plan.files) add(f.path, await storage.get(f.storageKey));
    const payslipById = new Map(payslips.map((p) => [p.payslipId, p]));
    const names = await storeNames(
      this.prisma,
      payslips.map((p) => p.storeId),
    );
    for (const p of plan.payslips) {
      const row = payslipById.get(p.payslipId)!;
      const detail = {
        ...toSummary(row, names(row.storeId)),
        isWithholdingApplied: row.isWithholdingApplied,
        items: row.payslipItems.map(({ payslipItemMaster, ...item }) => ({
          ...item,
          itemCode: payslipItemMaster.itemCode,
        })),
      };
      add(p.path, await renderPayslipPdf(payslipPdfModel(detail, p.staffName)));
    }
    return {
      buffer: zipArchive(entries),
      staffMemberIds: staff.map((s) => s.staffMemberId),
    };
  }

  /** BP 마스터 · 가맹마스터 사용 중 계정과 지금 관리하는 점포(점포 유형 · 상태 포함). 아니면 403 */
  private async viewer(adminAccountId: number): Promise<Viewer> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, roleTypeCode: true },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    if (!(BULK_EXPORT_ROLES as readonly string[]).includes(admin.roleTypeCode))
      throw new ForbiddenException(ROLE_DENIED_MESSAGE);
    const managed = await this.scope.getManageableStores(adminAccountId);
    if (!managed) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const stores = await this.prisma.store.findMany({
      where: { storeId: { in: managed.stores.map((s) => s.storeId) } },
      select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
      orderBy: { storeId: 'asc' },
    });
    return { adminAccountId, ...admin, stores };
  }

  private scopeIds(viewer: Viewer, storeIds?: number[]): number[] {
    const ids = resolveStoreIds(
      storeIds,
      viewer.stores.map((s) => s.storeId),
    );
    if (!ids) throw new BadRequestException(OUT_OF_SCOPE_MESSAGE);
    return ids;
  }

  private async items(
    rows: BulkExport[],
    now: Date,
  ): Promise<BulkExportItemDto[]> {
    const admins = await this.prisma.adminAccount.findMany({
      where: {
        adminAccountId: { in: [...new Set(rows.map((r) => r.requestedBy))] },
      },
      select: { adminAccountId: true, name: true, loginId: true },
    });
    const adminById = new Map(admins.map((a) => [a.adminAccountId, a]));
    return rows.map((r) => {
      const a = adminById.get(r.requestedBy);
      return {
        bulkExportId: r.bulkExportId,
        storeIds: r.storeIds,
        requestedAt: r.requestedAt.toISOString(),
        requesterName: a ? (a.name ?? a.loginId) : '-',
        staffCount: r.staffCount,
        status: r.status,
        completedAt: r.completedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        isExpired: r.expiresAt !== null && r.expiresAt <= now,
        failureReason: r.failureReason,
      };
    });
  }

  /** 만드는 중으로 오래 남은 것 — 시도가 남았으면 대기로, 아니면 실패로 */
  private async recoverStuck(now: Date): Promise<void> {
    const stuck = await this.prisma.bulkExport.findMany({
      where: {
        status: 'PROCESSING',
        startedAt: { lte: new Date(now.getTime() - STUCK_MS) },
      },
    });
    for (const job of stuck) {
      this.logger.warn(
        `bulk export STUCK id=${job.bulkExportId} attempt=${job.attemptCount}`,
      );
      await this.fail(job, FAILED_MESSAGE).catch((e: unknown) =>
        this.logger.error(
          `bulk export STUCK RECOVER ERROR id=${job.bulkExportId}: ${reasonOf(e)}`,
        ),
      );
    }
  }

  /** 대기 하나를 만드는 중으로 바꿔 가져온다. 다른 인스턴스가 잡은 행과 except 는 건너뛴다. */
  private async claim(except: number[], now: Date): Promise<BulkExport | null> {
    const ids = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE "bulk_exports"
         SET "status" = 'PROCESSING', "attempt_count" = "attempt_count" + 1, "started_at" = ${now}
       WHERE "bulk_export_id" = (
             SELECT "bulk_export_id" FROM "bulk_exports"
              WHERE "status" = 'PENDING'
                AND NOT ("bulk_export_id" = ANY(${except}::int[]))
              ORDER BY "requested_at", "bulk_export_id"
              LIMIT 1
                FOR UPDATE SKIP LOCKED)
      RETURNING "bulk_export_id" AS id`;
    if (!ids.length) return null;
    return this.prisma.bulkExport.findUnique({
      where: { bulkExportId: ids[0].id },
    });
  }

  private async runJob(job: BulkExport): Promise<void> {
    let key: string | null = null;
    let settled = false;
    try {
      const stores = await this.requesterStores(job);
      const { buffer, staffMemberIds } = await this.buildArchive(
        job.roleTypeCode,
        stores,
        new Date(),
      );
      key = StorageService.newKey('bulk-exports', job.bpCodeId, 'ZIP');
      await this.requireStorage().put(key, buffer, 'ZIP');
      const completedAt = new Date();
      settled = await this.settle(job, {
        status: 'SUCCEEDED',
        storageKey: key,
        fileSize: buffer.length,
        staffCount: staffMemberIds.length,
        staffMemberIds,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + BULK_EXPORT_TTL_MS),
        failureReason: null,
      });
      if (!settled) {
        this.logger.warn(
          `bulk export SETTLE LOST id=${job.bulkExportId} attempt=${job.attemptCount} — 다른 시도가 가져가 파일을 버린다`,
        );
        await this.discard(key);
      }
    } catch (error) {
      // 다시 해도 같은 거절(4xx — 권한 · 범위)은 바로 실패로 끝낸다
      const status = error instanceof HttpException ? error.getStatus() : null;
      const final = status !== null && status < 500;
      this.logger.warn(
        `bulk export FAILED id=${job.bulkExportId} attempt=${job.attemptCount}: ${reasonOf(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (key && !settled) await this.discard(key);
      // 화면에 보이는 사유 — 우리가 낸 거절(HttpException)의 문구만. 그 밖(DB · S3 오류)은 안쪽 사정이 섞이므로 공통 문구로, 원문은 로그에만
      await this.fail(
        job,
        error instanceof HttpException ? error.message : FAILED_MESSAGE,
        final,
      );
    }
  }

  /** 만들 때 다시 본다 — 요청자가 아직 그 BP · 권한 유형이고 요청의 점포를 모두 관리하는가. 아니면 403(바로 실패) */
  private async requesterStores(job: BulkExport): Promise<ScopeStore[]> {
    // 계정이 막혔거나 권한 유형이 바뀌면 viewer 가 403(바로 실패), DB 오류는 그대로 올라가 다시 시도한다
    const viewer = await this.viewer(job.requestedBy);
    const storeIds = viewer.stores.map((s) => s.storeId);
    if (!isVisibleTo(job, { ...viewer, storeIds }))
      throw new ForbiddenException(
        '요청한 관리자가 이 업무 범위를 더 이상 관리하지 않아 파일을 만들지 않았습니다.',
      );
    return storesOf(viewer, job.storeIds);
  }

  /** 시도가 아직 자기 것일 때만 바꾼다 — 그 사이 멈춘 작업으로 정리돼 다른 시도가 가져갔으면 0행 */
  private async settle(
    job: BulkExport,
    data: Prisma.BulkExportUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.bulkExport.updateMany({
      where: {
        bulkExportId: job.bulkExportId,
        status: 'PROCESSING',
        attemptCount: job.attemptCount,
      },
      data,
    });
    return count > 0;
  }

  private async fail(job: BulkExport, reason: string, final = false) {
    const settled = await this.settle(job, {
      status:
        final || job.attemptCount >= BULK_EXPORT_MAX_ATTEMPTS
          ? 'FAILED'
          : 'PENDING',
      failureReason: reason.slice(0, REASON_MAX),
    });
    if (!settled)
      this.logger.warn(
        `bulk export FAIL LOST id=${job.bulkExportId} attempt=${job.attemptCount} — 다른 시도가 가져갔다`,
      );
  }

  private async discard(key: string): Promise<void> {
    await this.storage
      ?.delete(key)
      .catch((error: unknown) =>
        this.logger.error(
          `bulk export file DISCARD FAILED key=${key}: ${reasonOf(error)}`,
        ),
      );
  }

  private requireStorage(): StorageService {
    if (!this.storage)
      throw new ServiceUnavailableException(NO_STORAGE_MESSAGE);
    return this.storage;
  }
}

function storesOf(viewer: Viewer, ids: readonly number[]): ScopeStore[] {
  const wanted = new Set(ids);
  return viewer.stores.filter((s) => wanted.has(s.storeId));
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    REASON_MAX,
  );
}
