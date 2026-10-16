import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AttachmentFileType, Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { containsText } from '../common/contains-text';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { platformOperators } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { StorageService } from '../storage/storage.service';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import type { CreateSupportInquiryDto } from './dto/create-support-inquiry.dto';
import type { ListSupportInquiriesDto } from './dto/list-support-inquiries.dto';
import type {
  CreatedSupportInquiryResponseDto,
  SupportInquiryListResponseDto,
  SupportInquiryResponseDto,
} from './dto/support-inquiry.response.dto';

/** 컨트롤러가 내용으로 검사한(assertUpload) 첨부 한 개. */
export interface InquiryUpload {
  fileName: string;
  buffer: Buffer;
  fileType: AttachmentFileType;
  sizeBytes: number;
}

const NOT_FOUND = '문의를 찾을 수 없습니다';
const PLATFORM_BP_CODE = 'BP000000';
/** 점포 단위 관리자 — 가맹 마스터 · 가맹 관리자. 공지 노출 대상 STORE 와 같은 기준이다. */
const STORE_ROLES = new Set(['FM', 'FA']);
/** 같은 문의를 다시 올리지 못하는 시간(2026-10-12 재영 승인) */
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
/** 첨부(10MB, 5개까지)를 문의 행이 생긴 뒤 트랜잭션 안에서 올린다 — 기본 5초로는 느린 업로드가 롤백된다. */
const UPLOAD_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * 관리자 웹 고객지원의 문의하기 (WHALEERP-281). 등록한 관리자 본인의 문의만 보인다 — 같은 BP 의 다른 관리자가 넣은
 * 문의도 보이지 않는다. 메뉴 권한은 컨트롤러가 본다.
 *
 * 등록하면 플랫폼 운영자에게 운영 알림(`NTF_INQUIRY_RECEIVED`)만 보낸다 — 메일은 없고, 문의자에게는 답변이 달릴
 * 때만 알린다(운영 정책 NTF-01 · 04). 커밋 뒤 응답을 기다리게 하지 않고 보내며, 실패해도 등록은 성공이다.
 */
@Injectable()
export class SupportInquiriesService {
  private readonly logger = new Logger(SupportInquiriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    private readonly ops: OpsNotificationService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  /**
   * 문의 등록. 대상 BP 는 등록한 관리자의 소속 BP, 대상 점포는 점포 단위 관리자일 때 그 점포다.
   * 같은 관리자가 제목 · 내용이 같은 문의를 5분 안에 다시 올리면 409 — 거듭 누른 제출은 거의 동시에 오므로 관리자
   * 단위로 잠근 뒤 확인한다. 첨부는 문의 행이 생긴 뒤 저장소에 올리고, 무엇이든 실패하면 올린 파일을 지운다.
   */
  async create(
    adminId: number,
    dto: CreateSupportInquiryDto,
    files: readonly InquiryUpload[],
  ): Promise<CreatedSupportInquiryResponseDto> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: adminId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { bpCodeId: true, roleTypeCode: true },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    await this.assertActiveCategory(dto.inquiryCategoryCode);
    // 저장소가 없다는 503 은 입력 검사 뒤에 낸다 — 400 을 가리지 않게. 첨부가 없으면 저장소를 부르지 않는다.
    const storage = files.length ? requireStorage(this.storage) : null;
    const storeId = await this.targetStoreOf(adminId, admin.roleTypeCode);

    const uploaded: string[] = [];
    let inquiryId: number;
    try {
      inquiryId = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inquiries:created_by:${adminId}`}))`;
          const duplicate = await tx.inquiry.findFirst({
            where: {
              createdBy: adminId,
              title: dto.title,
              body: dto.body,
              createdAt: { gt: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
            },
            select: { inquiryId: true },
          });
          // 안내 문구는 미정(Manyfast 질문) — 정해지면 바꾼다.
          if (duplicate)
            throw new ConflictException(
              '같은 문의가 방금 등록되었습니다. 문의 목록을 확인해 주세요',
            );
          const { inquiryId: id } = await tx.inquiry.create({
            data: {
              inquiryCategoryCode: dto.inquiryCategoryCode,
              title: dto.title,
              body: dto.body,
              createdBy: adminId,
              bpCodeId: admin.bpCodeId,
              storeId,
            },
            select: { inquiryId: true },
          });
          if (storage)
            await this.saveAttachments(tx, storage, id, files, uploaded);
          return id;
        },
        storage ? { timeout: UPLOAD_TRANSACTION_TIMEOUT_MS } : undefined,
      );
    } catch (error) {
      // 첨부는 썸네일 없이 올렸다. 한꺼번에 지워 S3 가 멈춰도 삭제 기한 한 번만 기다린다.
      if (storage)
        await Promise.all(
          uploaded.map((key) =>
            storage
              .delete(key, { thumbnail: false })
              .catch((e: unknown) =>
                this.logger.warn(`문의 첨부 정리 실패 ${key}: ${String(e)}`),
              ),
          ),
        );
      throw error;
    }

    // ponytail: 프로세스 안에서 뒤로 미룬다. 보내는 중에 서버가 내려가면 그 알림은 사라진다(문의 답변 알림과 같은 한계).
    void this.notifyReceived(inquiryId, admin.bpCodeId, storeId, dto.title);
    return { inquiryId };
  }

  /** 내 문의 목록. 등록 최신순. */
  async list(
    adminId: number,
    { status, title, page, pageSize }: ListSupportInquiriesDto,
  ): Promise<SupportInquiryListResponseDto> {
    const where: Prisma.InquiryWhereInput = {
      createdBy: adminId,
      ...(status && { status }),
      ...(title && { title: containsText(title) }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inquiry.findMany({
        where,
        select: {
          inquiryId: true,
          title: true,
          inquiryCategoryCode: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { inquiryId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inquiry.count({ where }),
    ]);
    const firstReplies = await this.prisma.inquiryReply.groupBy({
      by: ['inquiryId'],
      where: { inquiryId: { in: rows.map((r) => r.inquiryId) } },
      _min: { repliedAt: true },
    });
    const repliedAt = new Map(
      firstReplies.map((r) => [r.inquiryId, r._min.repliedAt]),
    );
    return {
      total,
      items: rows.map((r) => ({
        ...r,
        repliedAt: repliedAt.get(r.inquiryId) ?? null,
      })),
    };
  }

  /** 내 문의 상세. 남의 문의는 없는 문의처럼 404 다. */
  async get(
    adminId: number,
    inquiryId: number,
  ): Promise<SupportInquiryResponseDto> {
    const inquiry = await this.prisma.inquiry.findFirst({
      where: { inquiryId, createdBy: adminId },
      select: {
        inquiryId: true,
        title: true,
        inquiryCategoryCode: true,
        status: true,
        createdAt: true,
        body: true,
        processingStartedAt: true,
      },
    });
    if (!inquiry) throw new NotFoundException(NOT_FOUND);
    // 차례로 읽는다 — 연결을 하나만 받는 PGlite 소켓 서버(e2e)가 동시 연결을 끊는다.
    const replies = await this.prisma.inquiryReply.findMany({
      where: { inquiryId },
      select: { body: true, repliedAt: true },
      orderBy: [{ repliedAt: 'asc' }, { inquiryReplyId: 'asc' }],
    });
    const attachments = await this.prisma.inquiryAttachment.findMany({
      where: { inquiryId },
      select: {
        inquiryAttachmentId: true,
        fileName: true,
        fileType: true,
        sizeBytes: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
    const first = replies.at(0);
    const last = replies.at(-1);
    return {
      ...inquiry,
      repliedAt: first?.repliedAt ?? null,
      reply:
        first && last
          ? {
              body: last.body,
              repliedAt: first.repliedAt,
              editedAt: replies.length > 1 ? last.repliedAt : null,
            }
          : null,
      attachments,
    };
  }

  /** 내 문의의 첨부 내려받기 주소. 남의 문의 · 다른 문의의 첨부면 404. */
  async attachmentDownloadUrl(
    adminId: number,
    inquiryId: number,
    inquiryAttachmentId: number,
  ): Promise<DownloadUrlResponseDto> {
    const storage = requireStorage(this.storage);
    const attachment = await this.prisma.inquiryAttachment.findFirst({
      where: {
        inquiryAttachmentId,
        inquiryId,
        inquiry: { createdBy: adminId },
      },
      select: { storageKey: true, fileName: true },
    });
    if (!attachment) throw new NotFoundException('첨부파일을 찾을 수 없습니다');
    return {
      url: await storage.downloadUrl(
        attachment.storageKey,
        attachment.fileName,
      ),
    };
  }

  /** 문의 유형은 플랫폼고정 공통코드다. 사용 중지한 값은 받지 않는다. */
  private async assertActiveCategory(itemCode: string): Promise<void> {
    const found = await this.prisma.codeItem.count({
      where: {
        groupCode: 'INQUIRY_CATEGORY',
        itemCode,
        bpCode: PLATFORM_BP_CODE,
        status: 'ACTIVE',
        isDeleted: false,
      },
    });
    if (!found) throw new BadRequestException('문의 유형을 다시 선택해 주세요');
  }

  /**
   * 점포 단위 관리자(가맹)는 관리하는 점포를 대상 점포로 채우고, BP 단위 관리자는 비운다(2026-10-13 재영).
   * ponytail: 가맹 관리자가 점포를 여럿 관리하면 어느 점포인지 정할 수 없어 비운다 — 고르게 해야 하면 요청에
   * 점포를 받는다.
   */
  private async targetStoreOf(
    adminId: number,
    roleTypeCode: string,
  ): Promise<number | null> {
    if (!STORE_ROLES.has(roleTypeCode)) return null;
    const stores = await this.scope.listStores(adminId);
    return stores.length === 1 ? stores[0].storeId : null;
  }

  /** 첨부를 한꺼번에 올리고 행을 만든다. 올린 키는 uploaded 에 쌓는다 — 실패하면 부른 쪽이 지운다. */
  private async saveAttachments(
    tx: Prisma.TransactionClient,
    storage: StorageService,
    inquiryId: number,
    files: readonly InquiryUpload[],
    uploaded: string[],
  ): Promise<void> {
    const keys = files.map((f) =>
      StorageService.newKey('inquiries', inquiryId, f.fileType),
    );
    uploaded.push(...keys);
    try {
      await Promise.all(
        files.map((f, i) => storage.put(keys[i], f.buffer, f.fileType)),
      );
    } catch (error) {
      // 권한 · 버킷 설정 · 네트워크 오류는 화면에 같은 503 이다 — 원인은 여기에만 남는다.
      this.logger.error(
        `문의 첨부 올리기 실패 inquiry=${inquiryId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        '첨부파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
    await tx.inquiryAttachment.createMany({
      data: files.map((f, i) => ({
        inquiryId,
        fileName: f.fileName,
        fileType: f.fileType,
        sizeBytes: f.sizeBytes,
        storageKey: keys[i],
        sortOrder: i + 1,
      })),
    });
  }

  /** 운영 알림. 무엇이 실패해도 던지지 않는다. */
  private async notifyReceived(
    inquiryId: number,
    bpCodeId: number,
    storeId: number | null,
    title: string,
  ): Promise<void> {
    try {
      // 1팀 표라 Prisma 관계가 없다 — 차례로 읽는다.
      const bp = await this.prisma.bpCode.findUnique({
        where: { bpCodeId },
        select: { tradeName: true },
      });
      const store =
        storeId === null
          ? null
          : await this.prisma.store.findUnique({
              where: { storeId },
              select: { name: true },
            });
      await this.ops.notify({
        templateCode: 'NTF_INQUIRY_RECEIVED',
        // 템플릿 예시 「모리커피 연남점」 — BP 이름에 점포 이름을 잇는다.
        variables: {
          문의자: [bp?.tradeName, store?.name].filter(Boolean).join(' '),
          문의제목: title,
        },
        related: { type: 'INQUIRY', id: inquiryId },
        link: `/platform/community/inquiries/${inquiryId}`,
        eventKey: String(inquiryId),
        recipients: await platformOperators(this.prisma),
      });
    } catch (e: unknown) {
      this.logger.error(
        `inquiry received notification FAILED inquiry=${inquiryId}: ${reasonOf(e)}`,
      );
    }
  }
}
