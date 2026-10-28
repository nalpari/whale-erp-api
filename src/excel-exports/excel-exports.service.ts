import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExcelDownloadLog, Prisma } from '@prisma/client';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { adminWebLink, readOptionalAdminWebUrl } from '../common/admin-web-url';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, type OptionalStorage } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  admissionOf,
  afterFailure,
  deliveryMethodOf,
  EXCEL_FILE_SWEEP_MS,
  EXCEL_FILE_TTL_MS,
  EXCEL_LOG_RETENTION_YEARS,
  failedMailVariables,
  readyMailVariables,
} from './excel-export-policy';
import { ExcelExportRegistry } from './excel-export-registry';
import type {
  ExcelExportCaller,
  ExcelExportSource,
} from './excel-export-source';

/** 요청의 결과 — 1만 건 미만은 파일, 이상은 예약 생성(202). */
export type ExcelRequestResult =
  | { kind: 'file'; fileName: string; buffer: Buffer }
  | { kind: 'scheduled'; excelDownloadId: number; rowCount: number };

export type ExcelDownloadLink = {
  url: string;
  fileName: string;
  expiresAt: string;
};

/** 배치 한 번에 처리하는 예약 생성 수의 상한 — 한 틱이 다음 틱을 넘겨 쌓이지 않게. */
const PROCESS_LIMIT = 5;
/** 바로 받기가 생성 중으로 남은 지 이만큼이면 서버가 그 사이 죽은 것으로 본다 — 같은 화면이 막히지 않게 실패로 정리한다. */
const DIRECT_STUCK_MS = 10 * 60_000;
/** 예약 생성이 생성 중으로 남은 지(이번 시도 시작부터) 이만큼이면 배치가 중간에 죽은 것으로 보고 다시 대기(또는 실패)로 돌린다. */
const SCHEDULED_STUCK_MS = 60 * 60_000;
// 화면 · 로그가 읽을 만한 길이로 자른다(TEXT 칸).
const REASON_MAX = 1_000;
const BUSY_MESSAGE =
  '엑셀 파일을 만드는 중입니다. 다 만들어지면 등록한 이메일로 알려 드립니다';

/**
 * 모든 화면의 엑셀 공통(2026-10-28, 사용자 결정 — okf api/excel-exports.md). 화면은 ExcelExportSource 로 건수 · 파일만
 * 주고, 여기서 정책을 지킨다.
 * - 같은 사람 · 같은 화면은 생성 중이면 409, 아니면 1분에 한 번(429). 판단과 이력 쓰기는 (요청자, 메뉴) 잠금 안이다.
 * - 1만 건 미만은 바로 파일, 이상은 대기 이력만 남기고 202 — 배치(processPending)가 만들어 S3 에 24시간 두고 메일을 보낸다.
 * - 모든 요청을 excel_download_logs 에 남긴다(2년 보존, purgeExpired). 4xx 로 거절한 요청은 남기지 않는다.
 */
@Injectable()
export class ExcelExportsService {
  private readonly logger = new Logger(ExcelExportsService.name);
  private readonly adminWebUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ExcelExportRegistry,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
    config: ConfigService,
  ) {
    this.adminWebUrl = readOptionalAdminWebUrl(
      config.get<string>('ADMIN_WEB_URL'),
      isProduction(),
    );
  }

  async request<Q extends object>(
    source: ExcelExportSource<Q>,
    caller: ExcelExportCaller,
    query: Q,
    now: Date = new Date(),
  ): Promise<ExcelRequestResult> {
    const menuId = await this.menuIdOf(source.menuUrl);
    const requestedBy = caller.adminAccountId;
    // 먼저 잠금 없이 거른다 — 생성 중 · 1분 안이면 세지도 않는다.
    await this.assertAdmitted(this.prisma, requestedBy, menuId, now);
    // 건수는 트랜잭션 밖에서 센다. 화면은 주입받은 PrismaService 로 세므로, 트랜잭션이 커넥션을 쥔 채 부르면 풀이 바닥났을 때
    // (커넥션 하나면 늘) 교착이다. 범위 · 권한 거절(4xx)은 여기서 던진다 — 이력을 남기지 않아 1분에 세지 않는다.
    const rowCount = await source.count(caller, query);
    const deliveryMethod = deliveryMethodOf(rowCount);
    const log = await this.prisma.$transaction(
      async (tx) => {
        // 같은 사람 · 같은 화면의 판단과 쓰기를 한 줄로 세우고 다시 판단한다 — 두 번 누른 요청은 여기서 하나만 지나간다.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`excel-exports:${requestedBy}:${menuId}`}))`;
        await this.assertAdmitted(tx, requestedBy, menuId, now);
        if (deliveryMethod === 'SCHEDULED')
          await this.assertCanSchedule(tx, requestedBy);
        return tx.excelDownloadLog.create({
          data: {
            requestedBy,
            menuId,
            bpCodeId: caller.bp?.bpCodeId ?? null,
            searchConditions: instanceToPlain(query) as Prisma.InputJsonObject,
            rowCount,
            deliveryMethod,
            status: deliveryMethod === 'DIRECT' ? 'PROCESSING' : 'PENDING',
            fileName: source.fileName(now),
            requestedAt: now,
            // 바로 받기는 지금 만들기 시작한다. 예약 생성은 배치가 가져갈 때 적는다(claim).
            ...(deliveryMethod === 'DIRECT' && { startedAt: now }),
          },
        });
      },
      { timeout: 60_000, maxWait: 5_000 },
    );

    if (log.deliveryMethod === 'SCHEDULED')
      return {
        kind: 'scheduled',
        excelDownloadId: log.excelDownloadId,
        rowCount: log.rowCount,
      };
    try {
      const buffer = await source.build(caller, query);
      await this.prisma.excelDownloadLog.update({
        where: { excelDownloadId: log.excelDownloadId },
        data: { status: 'SUCCEEDED', completedAt: new Date() },
      });
      return { kind: 'file', fileName: log.fileName, buffer };
    } catch (error) {
      await this.prisma.excelDownloadLog.update({
        where: { excelDownloadId: log.excelDownloadId },
        data: { status: 'FAILED', failureReason: reasonOf(error) },
      });
      throw error;
    }
  }

  /**
   * 예약 생성 배치 한 번. 먼저 멈춘 작업을 정리하고, 대기 중인 것을 하나씩 가져와(SKIP LOCKED — 인스턴스가 여럿이어도 한 번만)
   * 만든다. 처리한 수를 돌려준다.
   */
  async processPending(now: Date = new Date()): Promise<number> {
    await this.recoverStuck(now);
    // 이번 실행에서 다룬 작업은 다시 집지 않는다 — 실패해 대기로 돌아간 작업의 다시 시도는 다음 실행(1분 뒤)이다.
    const handled: number[] = [];
    while (handled.length < PROCESS_LIMIT) {
      const job = await this.claim(handled);
      if (!job) break;
      handled.push(job.excelDownloadId);
      await this.runJob(job);
    }
    return handled.length;
  }

  /** 예약 생성한 파일의 짧은 주소. 요청한 본인 · 완료 · 기한 안일 때만. 받은 시각을 남긴다. */
  async download(
    adminAccountId: number,
    excelDownloadId: number,
    now: Date = new Date(),
  ): Promise<ExcelDownloadLink> {
    const log = await this.prisma.excelDownloadLog.findFirst({
      where: {
        excelDownloadId,
        requestedBy: adminAccountId,
        deliveryMethod: 'SCHEDULED',
      },
    });
    if (!log) throw new NotFoundException('엑셀 파일을 찾을 수 없습니다');
    if (log.status !== 'SUCCEEDED' || !log.storageKey || !log.expiresAt)
      throw new ConflictException(
        log.status === 'FAILED'
          ? '엑셀 파일을 만들지 못했습니다. 다시 요청해 주세요'
          : BUSY_MESSAGE,
      );
    if (log.expiresAt.getTime() <= now.getTime())
      throw new GoneException(
        '내려받기 기한(24시간)이 지났습니다. 다시 요청해 주세요',
      );
    const url = await this.requireStorage().downloadUrl(
      log.storageKey,
      log.fileName,
    );
    await this.prisma.excelDownloadLog.update({
      where: { excelDownloadId },
      data: { downloadedAt: now },
    });
    return {
      url,
      fileName: log.fileName,
      expiresAt: log.expiresAt.toISOString(),
    };
  }

  /** 2년이 지난 이력을 지운다(사건 기록이라 지움 표시 없이 DELETE). 지운 수를 돌려준다. */
  async purgeExpired(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<number> {
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - EXCEL_LOG_RETENTION_YEARS);
    const { count } = await tx.excelDownloadLog.deleteMany({
      where: { requestedAt: { lt: cutoff } },
    });
    return count;
  }

  /**
   * 기한이 지난 예약 생성 파일을 S3 에서 지운다. 지운 수를 돌려준다. 이력에 지운 표시를 두지 않으므로 최근 7일 안에 기한이
   * 지난 것을 매일 다시 지운다(없는 키도 성공) — 버킷 수명 주기 규칙이 없어도 개인정보가 든 파일이 남지 않게 코드가 지운다.
   * 하나가 실패해도 나머지는 지우고, 실패한 것은 다음 날 다시 지운다.
   */
  async deleteExpiredFiles(now: Date = new Date()): Promise<number> {
    if (!this.storage) return 0;
    const rows = await this.prisma.excelDownloadLog.findMany({
      where: {
        deliveryMethod: 'SCHEDULED',
        status: 'SUCCEEDED',
        storageKey: { not: null },
        expiresAt: {
          lte: now,
          gt: new Date(now.getTime() - EXCEL_FILE_SWEEP_MS),
        },
      },
      select: { storageKey: true },
    });
    let deleted = 0;
    for (const { storageKey } of rows) {
      if (!storageKey) continue;
      try {
        await this.storage.delete(storageKey);
        deleted += 1;
      } catch (error) {
        this.logger.warn(
          `excel export file DELETE FAILED key=${storageKey}: ${reasonOf(error)}`,
        );
      }
    }
    return deleted;
  }

  /** 같은 사람 · 같은 화면이 생성 중이면 409, 1분 안이면 429. */
  private async assertAdmitted(
    db: Prisma.TransactionClient | PrismaService,
    requestedBy: number,
    menuId: number,
    now: Date,
  ): Promise<void> {
    const latest = await db.excelDownloadLog.findFirst({
      where: { requestedBy, menuId },
      orderBy: [{ requestedAt: 'desc' }, { excelDownloadId: 'desc' }],
      select: { status: true, requestedAt: true },
    });
    const admission = admissionOf(latest, now);
    if (admission.kind === 'busy') throw new ConflictException(BUSY_MESSAGE);
    if (admission.kind === 'wait')
      throw new HttpException(
        `엑셀은 1분에 한 번 받을 수 있습니다. ${admission.seconds}초 뒤 다시 받아 주세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  private async menuIdOf(menuUrl: string): Promise<number> {
    const menu = await this.prisma.menu.findFirst({
      where: { url: menuUrl, isDeleted: false, status: 'ACTIVE' },
      select: { menuId: true },
    });
    // 소스가 가리키는 메뉴가 없으면 설정 잘못이다 — 화면은 메뉴 권한 가드를 지나왔으므로 사용자 오류가 아니다.
    if (!menu) throw new Error(`엑셀 소스의 메뉴가 없습니다: ${menuUrl}`);
    return menu.menuId;
  }

  /** 예약 생성은 메일 · 관리자 웹 주소 · 저장소와 받는 주소가 있어야 한다 — 없으면 만들어도 알릴 수 없다. */
  private async assertCanSchedule(
    tx: Prisma.TransactionClient,
    adminAccountId: number,
  ): Promise<void> {
    if (!this.mail || !this.adminWebUrl || !this.storage)
      throw new ServiceUnavailableException(
        '지금은 1만 건 이상 엑셀을 만들 수 없습니다. 검색 조건을 좁혀 주세요',
      );
    const admin = await tx.adminAccount.findUnique({
      where: { adminAccountId },
      select: { email: true },
    });
    if (!admin?.email)
      throw new BadRequestException(
        '등록한 이메일이 없어 1만 건 이상 엑셀을 받을 수 없습니다. 검색 조건을 좁혀 주세요',
      );
  }

  /**
   * 서버가 죽어 생성 중으로 남은 것 — 바로 받기는 실패로, 예약 생성은 다시 대기(시도가 남았으면)로. 이번 시도를 시작한
   * 시각(started_at)으로 판단한다 — 요청 시각으로 재면 오래 기다린 작업이 막 시작하자마자 멈춘 것으로 빼앗긴다.
   */
  private async recoverStuck(now: Date): Promise<void> {
    const reason = '생성 중 서버가 멈췄다';
    await this.prisma.excelDownloadLog.updateMany({
      where: {
        deliveryMethod: 'DIRECT',
        status: 'PROCESSING',
        startedAt: { lte: new Date(now.getTime() - DIRECT_STUCK_MS) },
      },
      data: { status: 'FAILED', failureReason: reason },
    });
    const stuck = await this.prisma.excelDownloadLog.findMany({
      where: {
        deliveryMethod: 'SCHEDULED',
        status: 'PROCESSING',
        startedAt: { lte: new Date(now.getTime() - SCHEDULED_STUCK_MS) },
      },
    });
    for (const job of stuck) await this.fail(job, reason);
  }

  /**
   * 이 시도가 아직 자기 것일 때만 상태를 바꾼다 — 생성 중 · 같은 시도 횟수. 그 사이 멈춘 작업으로 정리돼 다른 시도가
   * 가져갔으면 0행이고, 그러면 메일을 보내지 않는다(두 번 보내거나 실패 · 완료 메일이 함께 가지 않게).
   */
  private async settle(
    job: ExcelDownloadLog,
    data: Prisma.ExcelDownloadLogUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.excelDownloadLog.updateMany({
      where: {
        excelDownloadId: job.excelDownloadId,
        status: 'PROCESSING',
        attemptCount: job.attemptCount,
      },
      data,
    });
    return count > 0;
  }

  /** 대기 중인 예약 하나를 생성 중으로 바꿔 가져온다. 다른 인스턴스가 잡은 행과 except 는 건너뛴다. */
  private async claim(except: number[]): Promise<ExcelDownloadLog | null> {
    const ids = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE "excel_download_logs"
         SET "status" = 'PROCESSING', "attempt_count" = "attempt_count" + 1, "started_at" = ${new Date()}
       WHERE "excel_download_id" = (
             SELECT "excel_download_id" FROM "excel_download_logs"
              WHERE "status" = 'PENDING'
                AND NOT ("excel_download_id" = ANY(${except}::int[]))
              ORDER BY "requested_at", "excel_download_id"
              LIMIT 1
                FOR UPDATE SKIP LOCKED)
      RETURNING "excel_download_id" AS id`;
    if (!ids.length) return null;
    return this.prisma.excelDownloadLog.findUnique({
      where: { excelDownloadId: ids[0].id },
    });
  }

  private async runJob(job: ExcelDownloadLog): Promise<void> {
    let screenName = '엑셀';
    let key: string | null = null;
    let settled = false;
    let expiresAt = new Date(0);
    try {
      const menu = await this.prisma.menu.findUniqueOrThrow({
        where: { menuId: job.menuId },
        select: { url: true },
      });
      const source = menu.url ? this.registry.find(menu.url) : null;
      if (!source) throw new Error(`엑셀 소스가 없습니다: ${menu.url}`);
      screenName = source.screenName;
      const caller = await this.callerOf(job);
      const query = plainToInstance(source.queryType, job.searchConditions);
      const buffer = await source.build(caller, query);
      const storage = this.requireStorage();
      key = StorageService.newKey('excel-exports', job.requestedBy, 'XLSX');
      await storage.put(key, buffer, 'XLSX');
      // 기한은 실제로 다 만든 시각부터다 — 한 번에 여러 건을 만들면 배치 시작 시각과 몇 분씩 다르다.
      const completedAt = new Date();
      expiresAt = new Date(completedAt.getTime() + EXCEL_FILE_TTL_MS);
      settled = await this.settle(job, {
        status: 'SUCCEEDED',
        storageKey: key,
        completedAt,
        expiresAt,
        failureReason: null,
      });
      if (!settled) {
        this.logger.warn(
          `excel export LOST id=${job.excelDownloadId} attempt=${job.attemptCount} — 다른 시도가 가져갔다`,
        );
        await this.discard(key);
        return;
      }
    } catch (error) {
      this.logger.warn(
        `excel export FAILED id=${job.excelDownloadId} attempt=${job.attemptCount}: ${reasonOf(error)}`,
      );
      // 완료로 적기 전에 실패했으면 올려 둔 파일은 쓸 데가 없다.
      if (key && !settled) await this.discard(key);
      await this.fail(job, reasonOf(error), screenName);
      return;
    }
    // 완료로 적은 뒤의 일은 실패해도 작업을 되돌리지 않는다 — 메일은 notify 가 실패를 삼킨다.
    await this.notify(job, 'EMAIL_EXCEL_READY', () =>
      readyMailVariables({
        screenName,
        rowCount: job.rowCount,
        expiresAt,
        link: adminWebLink(
          this.adminWebUrl ?? '',
          `/excel-downloads/${job.excelDownloadId}`,
        ),
      }),
    );
  }

  /** 쓰지 않게 된 파일을 지운다. 실패해도 던지지 않는다 — 기한 정리와 버킷 수명 주기 규칙이 남는다. */
  private async discard(key: string): Promise<void> {
    try {
      await this.storage?.delete(key);
    } catch (error) {
      this.logger.warn(
        `excel export file DISCARD FAILED key=${key}: ${reasonOf(error)}`,
      );
    }
  }

  /** 시도가 남았으면 다시 대기, 아니면 실패로 끝내고 실패 메일. */
  private async fail(
    job: ExcelDownloadLog,
    reason: string,
    screenName?: string,
  ): Promise<void> {
    const status = afterFailure(job.attemptCount);
    const settled = await this.settle(job, {
      status,
      failureReason: reason.slice(0, REASON_MAX),
    });
    if (!settled || status !== 'FAILED') return;
    const name = screenName ?? (await this.screenNameOf(job.menuId)) ?? '엑셀';
    await this.notify(job, 'EMAIL_EXCEL_FAILED', () =>
      failedMailVariables({ screenName: name, requestedAt: job.requestedAt }),
    );
  }

  /** 완료 · 실패 메일. 보내지 못해도 던지지 않는다 — 파일 · 이력은 이미 맞다. 보낸 시각만 남긴다. */
  private async notify(
    job: ExcelDownloadLog,
    templateCode: 'EMAIL_EXCEL_READY' | 'EMAIL_EXCEL_FAILED',
    variables: () => Record<string, string>,
  ): Promise<void> {
    try {
      const admin = await this.prisma.adminAccount.findUnique({
        where: { adminAccountId: job.requestedBy },
        select: { email: true },
      });
      if (!this.mail || !admin?.email) {
        this.logger.warn(
          `excel export mail SKIPPED id=${job.excelDownloadId} ${!this.mail ? 'no MAIL_*' : 'no email'}`,
        );
        return;
      }
      await this.mail.send({
        templateCode,
        to: admin.email,
        variables: variables(),
        adminAccountId: job.requestedBy,
      });
      await this.prisma.excelDownloadLog.update({
        where: { excelDownloadId: job.excelDownloadId },
        data: { notifiedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `excel export mail FAILED id=${job.excelDownloadId}: ${reasonOf(error)}`,
      );
    }
  }

  /** 저장해 둔 대상 BP 로 요청 때의 호출자를 다시 만든다. 플랫폼 계정인지는 지금의 계정으로 판단한다. */
  private async callerOf(job: ExcelDownloadLog): Promise<ExcelExportCaller> {
    if (job.bpCodeId === null)
      return { adminAccountId: job.requestedBy, bp: null };
    const admin = await this.prisma.adminAccount.findUniqueOrThrow({
      where: { adminAccountId: job.requestedBy },
      select: { roleTypeCode: true, bpCode: { select: { isPlatform: true } } },
    });
    return {
      adminAccountId: job.requestedBy,
      bp: {
        bpCodeId: job.bpCodeId,
        isPlatformCaller: isPlatformRole(
          admin.roleTypeCode,
          admin.bpCode.isPlatform,
        ),
      },
    };
  }

  private async screenNameOf(menuId: number): Promise<string | null> {
    const menu = await this.prisma.menu.findUnique({
      where: { menuId },
      select: { url: true },
    });
    return (menu?.url && this.registry.find(menu.url)?.screenName) ?? null;
  }

  private requireStorage(): StorageService {
    if (!this.storage)
      throw new ServiceUnavailableException(
        '첨부파일 저장소가 설정되지 않았습니다.',
      );
    return this.storage;
  }
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    REASON_MAX,
  );
}
