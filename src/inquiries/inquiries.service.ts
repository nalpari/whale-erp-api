import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { adminNames } from '../common/admin-names';
import { adminWebLink, readOptionalAdminWebUrl } from '../common/admin-web-url';
import { statusesOf } from '../common/answer-status';
import { containsText } from '../common/contains-text';
import {
  memoValue,
  type SaveInternalMemoDto,
} from '../common/save-internal-memo.dto';
import { sameMillisecond } from '../common/updated-at';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { activeAdmin } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import type { CreateInquiryReplyDto } from './dto/create-inquiry-reply.dto';
import type {
  InquiryListResponseDto,
  InquiryResponseDto,
} from './dto/inquiry.response.dto';
import type { InquiryStateResponseDto } from './dto/inquiry-state.response.dto';
import type { ListInquiriesDto } from './dto/list-inquiries.dto';

const NOT_FOUND = '문의를 찾을 수 없습니다';
const STALE = '그사이 다른 운영자가 저장했습니다. 다시 불러온 뒤 저장해 주세요';
const STATE = { inquiryId: true, status: true, updatedAt: true } as const;

type Answered = { createdBy: number; title: string };

/**
 * 커뮤니티 관리 문의사항 — 목록 · 상세(WHALEERP-332)와 처리중 · 답변 · 내부 메모(WHALEERP-274). 플랫폼 관리자만
 * 쓴다 — 권한은 컨트롤러가 본다.
 *
 * 바꾼 행의 상태는 행 잠금을 쥔 트랜잭션 안에서 읽어 돌려준다. 커밋 뒤에 따로 읽으면 그사이 다른 운영자가 저장한
 * updatedAt 을 돌려줘, 이 운영자의 다음 저장이 409 없이 남의 저장을 덮는다.
 *
 * 첫 답변이면 등록한 관리자에게 운영 알림과 메일을 보낸다(운영 정책 NTF-03 · 04). 둘은 서로의 실패에 묶이지 않고,
 * 커밋 뒤에 응답을 기다리게 하지 않고 보낸다 — SMTP 가 멈춰 응답이 늦으면 운영자는 실패로 알고 다시 저장해 엉뚱한
 * 409 를 받는다. 실패해도 답변 저장은 성공이다.
 */
@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);
  private readonly adminWebUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
    config: ConfigService,
  ) {
    // 잘못된 값은 여기서 던져 기동을 멈춘다. 비었으면 null — 답변 메일만 건너뛴다.
    this.adminWebUrl = readOptionalAdminWebUrl(
      config.get<string>('ADMIN_WEB_URL'),
      isProduction(),
    );
    // 운영에서 비어 있으면 기동은 하되 남긴다 — 사업자 관리자가 「메일이 안 온다」고 묻기 전에 배포 로그에서 알게.
    if (isProduction() && (!this.mail || !this.adminWebUrl))
      this.logger.error(
        `${!this.mail ? 'MAIL_*' : 'ADMIN_WEB_URL'} 이 비어 있어 문의 답변 메일을 보낼 수 없다`,
      );
  }

  /** 커뮤니티 관리 문의사항 목록 (#332). 접수 최신순. */
  async list({
    answerStatus,
    title,
    sender,
    page,
    pageSize,
  }: ListInquiriesDto): Promise<InquiryListResponseDto> {
    const where: Prisma.InquiryWhereInput = {
      ...(answerStatus && { status: { in: statusesOf(answerStatus) } }),
      ...(title && { title: containsText(title) }),
      ...(sender && { OR: await this.sentFrom(sender) }),
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
          bpCodeId: true,
          storeId: true,
          createdBy: true,
        },
        orderBy: [{ createdAt: 'desc' }, { inquiryId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inquiry.count({ where }),
    ]);
    // 이름 조회는 차례로 한다 — 연결을 하나만 받는 PGlite 소켓 서버(e2e)가 동시 연결을 끊는다. 작은 IN 조회 셋이다.
    const bps = await this.bpNames(rows.map((r) => r.bpCodeId));
    const stores = await this.storeNames(rows.map((r) => r.storeId));
    const admins = await adminNames(
      this.prisma,
      rows.map((r) => r.createdBy),
    );
    return {
      total,
      items: rows.map(({ bpCodeId, storeId, createdBy, ...rest }) => ({
        ...rest,
        bpName: bps.get(bpCodeId) ?? null,
        storeName: storeId === null ? null : (stores.get(storeId) ?? null),
        senderName: admins.get(createdBy) ?? null,
      })),
    };
  }

  /** 문의 첨부 내려받기 주소 (#332). 다른 문의의 첨부 ID 로는 받지 못한다. */
  async attachmentDownloadUrl(
    inquiryId: number,
    inquiryAttachmentId: number,
  ): Promise<DownloadUrlResponseDto> {
    const storage = requireStorage(this.storage);
    const attachment = await this.prisma.inquiryAttachment.findFirst({
      where: { inquiryAttachmentId, inquiryId },
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

  /** 커뮤니티 관리 문의사항 상세 (#332). 답변은 고친 이력까지 오래된 것부터 준다. */
  async get(inquiryId: number): Promise<InquiryResponseDto> {
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { inquiryId },
    });
    if (!inquiry) throw new NotFoundException(NOT_FOUND);
    // include 로 두 관계를 함께 읽으면 Prisma 가 쿼리를 동시에 보내 PGlite 소켓 서버(e2e)가 연결을 끊는다 — 따로 읽는다.
    const inquiryReplies = await this.prisma.inquiryReply.findMany({
      where: { inquiryId },
      select: {
        inquiryReplyId: true,
        body: true,
        repliedAt: true,
        repliedBy: true,
      },
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
    const { bpCodeId, storeId } = inquiry;
    const adminIds = [
      inquiry.createdBy,
      inquiry.processingStartedBy,
      ...inquiryReplies.map((r) => r.repliedBy),
    ];
    const bps = await this.bpNames([bpCodeId]);
    const stores = await this.storeNames([storeId]);
    const admins = await this.prisma.adminAccount.findMany({
      where: {
        adminAccountId: {
          in: [...new Set(adminIds.filter((id) => id !== null))],
        },
      },
      select: { adminAccountId: true, name: true, roleTypeCode: true },
    });
    const admin = new Map(admins.map((a) => [a.adminAccountId, a]));
    const nameOf = (id: number | null) =>
      (id === null ? null : admin.get(id)?.name) ?? null;
    // 칸을 하나씩 옮긴다 — 행을 펼치면 테이블에 더해진 칸이 응답에 저절로 실린다.
    return {
      inquiryId: inquiry.inquiryId,
      title: inquiry.title,
      inquiryCategoryCode: inquiry.inquiryCategoryCode,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
      bpName: bps.get(bpCodeId) ?? null,
      storeName: storeId === null ? null : (stores.get(storeId) ?? null),
      senderName: nameOf(inquiry.createdBy),
      body: inquiry.body,
      createdBy: inquiry.createdBy,
      senderRoleTypeCode: admin.get(inquiry.createdBy)?.roleTypeCode ?? null,
      processingStartedAt: inquiry.processingStartedAt,
      processingStartedBy: inquiry.processingStartedBy,
      processingStartedByName: nameOf(inquiry.processingStartedBy),
      replies: inquiryReplies.map((r) => ({
        ...r,
        repliedByName: nameOf(r.repliedBy),
      })),
      attachments,
      internalMemo: inquiry.internalMemo,
      updatedAt: inquiry.updatedAt,
    };
  }

  /**
   * 접수 상태만 처리중으로 바꾼다. 바꾼 관리자 · 시각은 상세 처리 이력의 「확인」 줄이다(2026-10-13 재영).
   * 상태를 조건에 넣은 UPDATE 라 둘이 동시에 눌러도 하나만 바뀌고 나머지는 409 다. `@updatedAt` 이라 updatedAt 도
   * 바뀐다 — 그사이 답변을 쓰던 운영자의 저장은 409 다.
   */
  async startProcessing(
    adminId: number,
    inquiryId: number,
  ): Promise<InquiryStateResponseDto> {
    const state = await this.updateAndRead(
      { inquiryId, status: 'RECEIVED' },
      {
        status: 'IN_PROGRESS',
        processingStartedBy: adminId,
        processingStartedAt: new Date(),
      },
    );
    if (state) return state;
    const current = await this.stateOf(inquiryId);
    throw new ConflictException(
      current.status === 'ANSWERED'
        ? '이미 답변한 문의입니다'
        : '이미 처리중인 문의입니다',
    );
  }

  /**
   * 답변을 저장하고 답변 완료로 바꾼다. 처리중을 거치지 않아도 된다. 고칠 때도 새 행을 더해 이전 답변 · 고친
   * 시각 · 고친 운영자가 남고, 상태는 답변 완료 그대로이며 다시 알리지 않는다(CNT-17).
   *
   * 읽은 뒤 아무도 저장하지 않았을 때만 저장한다. `updatedAt` 을 조건에 넣은 UPDATE 라, 동시에 두 답변이 와도
   * PostgreSQL 이 뒤의 것을 행 잠금 뒤 다시 평가해 0 건이 된다 — 그쪽이 409 다. 「첫 답변」은 저장 전 상태로
   * 가르는데, 그 사이에 누가 끼어들면 이 UPDATE 가 0 건이라 두 요청이 모두 첫 답변으로 성공하는 일은 없다.
   */
  async reply(
    adminId: number,
    inquiryId: number,
    dto: CreateInquiryReplyDto,
  ): Promise<InquiryStateResponseDto> {
    const before = await this.prisma.inquiry.findUnique({
      where: { inquiryId },
      select: { status: true, createdBy: true, title: true },
    });
    if (!before) throw new NotFoundException(NOT_FOUND);

    const state = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.inquiry.updateMany({
        where: { inquiryId, updatedAt: sameMillisecond(dto.updatedAt) },
        data: { status: 'ANSWERED' },
      });
      if (count === 0) throw new ConflictException(STALE);
      await tx.inquiryReply.create({
        data: { inquiryId, body: dto.body, repliedBy: adminId },
      });
      return tx.inquiry.findUniqueOrThrow({
        where: { inquiryId },
        select: STATE,
      });
    });

    // ponytail: 프로세스 안에서 뒤로 미룬다. 보내는 중에 서버가 내려가면 그 알림 · 메일은 사라진다(로그도 없다).
    // 잃으면 안 되게 되면 발송 대기 표 + 배치로 옮긴다.
    if (before.status !== 'ANSWERED')
      void this.notifyAnswered(inquiryId, before);
    return state;
  }

  async saveInternalMemo(
    inquiryId: number,
    dto: SaveInternalMemoDto,
  ): Promise<InquiryStateResponseDto> {
    const state = await this.updateAndRead(
      { inquiryId, updatedAt: sameMillisecond(dto.updatedAt) },
      { internalMemo: memoValue(dto.internalMemo) },
    );
    if (state) return state;
    await this.stateOf(inquiryId); // 없으면 404
    throw new ConflictException(STALE);
  }

  /** 조건에 맞으면 바꾸고 바꾼 행을 같은 트랜잭션 안에서 읽는다. 맞는 행이 없으면 null. */
  private updateAndRead(
    where: Prisma.InquiryWhereInput & { inquiryId: number },
    data: Prisma.InquiryUncheckedUpdateManyInput,
  ): Promise<InquiryStateResponseDto | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.inquiry.updateMany({ where, data });
      if (count === 0) return null;
      return tx.inquiry.findUniqueOrThrow({
        where: { inquiryId: where.inquiryId },
        select: STATE,
      });
    });
  }

  /** 운영 알림과 메일을 보낸다. 서로의 실패에 묶이지 않고, 무엇이 실패해도 던지지 않는다. */
  private async notifyAnswered(
    inquiryId: number,
    inquiry: Answered,
  ): Promise<void> {
    // 고객지원 쪽 문의 상세다 — 받는 사람은 문의를 등록한 사업자 관리자다.
    const path = `/support-inquiries/${inquiryId}`;
    await Promise.all([
      this.notifyOps(inquiryId, inquiry, path).catch((e: unknown) =>
        this.logger.error(
          `inquiry answered notification FAILED inquiry=${inquiryId}: ${reasonOf(e)}`,
        ),
      ),
      this.sendMail(inquiryId, inquiry, path).catch((e: unknown) =>
        // 메시지는 남기지 않는다 — SMTP 오류에는 받는 주소가 섞인다. SMTP 단계의 결과는 MailService 가 주소를
        // 가려 로그와 mail_send_logs 에 남기고, 그 전 단계(템플릿 · 주소 · 변수) 오류는 이 한 줄만 남는다.
        this.logger.error(
          `inquiry answered mail FAILED inquiry=${inquiryId} ${errorKind(e)}`,
        ),
      ),
    ]);
  }

  private async notifyOps(
    inquiryId: number,
    inquiry: Answered,
    path: string,
  ): Promise<void> {
    await this.ops.notify({
      templateCode: 'NTF_INQUIRY_ANSWERED',
      variables: { 문의제목: inquiry.title },
      related: { type: 'INQUIRY', id: inquiryId },
      link: path,
      eventKey: String(inquiryId),
      recipients: await activeAdmin(this.prisma, inquiry.createdBy),
    });
  }

  private async sendMail(
    inquiryId: number,
    inquiry: Answered,
    path: string,
  ): Promise<void> {
    const at = `inquiry=${inquiryId}`;
    if (!this.mail || !this.adminWebUrl) {
      this.logger.warn(
        `inquiry answered mail SKIPPED ${!this.mail ? 'no MAIL_*' : 'no ADMIN_WEB_URL'} ${at}`,
      );
      return;
    }
    const to = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: inquiry.createdBy,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { email: true },
    });
    if (!to?.email) {
      this.logger.warn(
        `inquiry answered mail SKIPPED inactive author or no email ${at}`,
      );
      return;
    }
    await this.mail.send({
      templateCode: 'EMAIL_INQUIRY_ANSWERED',
      to: to.email,
      variables: {
        문의제목: inquiry.title,
        링크: adminWebLink(this.adminWebUrl, path),
      },
      adminAccountId: inquiry.createdBy,
      // sentBy 는 비운다 — 관리자가 화면에서 대신 보낸 것이 아니라 답변이 남긴 시스템 알림이다.
    });
  }

  /**
   * 보낸 곳 검색 — BP 이름 · 점포 이름 · 보낸 사람 이름 중 하나에 들어 있는 문의. 1팀 표라 Prisma 관계가 없어
   * ID 를 먼저 찾는다. 지운 BP · 점포 · 계정도 찾는다 — 문의는 보낸 그때의 기록이다.
   */
  private async sentFrom(name: string): Promise<Prisma.InquiryWhereInput[]> {
    // ponytail: 이름에 맞는 ID 를 모두 IN 으로 넘긴다. 한 이름에 맞는 행이 수천이 되면 SQL 조인으로 바꾼다.
    const contains = containsText(name);
    const bps = await this.prisma.bpCode.findMany({
      where: { tradeName: contains },
      select: { bpCodeId: true },
    });
    const stores = await this.prisma.store.findMany({
      where: { name: contains },
      select: { storeId: true },
    });
    const admins = await this.prisma.adminAccount.findMany({
      where: { name: contains },
      select: { adminAccountId: true },
    });
    return [
      { bpCodeId: { in: bps.map((b) => b.bpCodeId) } },
      { storeId: { in: stores.map((s) => s.storeId) } },
      { createdBy: { in: admins.map((a) => a.adminAccountId) } },
    ];
  }

  private async bpNames(ids: number[]): Promise<Map<number, string>> {
    const rows = await this.prisma.bpCode.findMany({
      where: { bpCodeId: { in: [...new Set(ids)] } },
      select: { bpCodeId: true, tradeName: true },
    });
    return new Map(rows.map((r) => [r.bpCodeId, r.tradeName]));
  }

  private async storeNames(
    ids: (number | null)[],
  ): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.prisma.store.findMany({
      where: { storeId: { in: wanted } },
      select: { storeId: true, name: true },
    });
    return new Map(rows.map((r) => [r.storeId, r.name]));
  }

  private async stateOf(inquiryId: number): Promise<InquiryStateResponseDto> {
    const row = await this.prisma.inquiry.findUnique({
      where: { inquiryId },
      select: STATE,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}

/** 로그에 남길 오류 종류 — 이름과 코드만. 메시지에는 개인정보(받는 주소 등)가 섞일 수 있다. */
function errorKind(e: unknown): string {
  const { name, code } = (e ?? {}) as { name?: unknown; code?: unknown };
  return `error=${String(name)} code=${String(code)}`;
}
