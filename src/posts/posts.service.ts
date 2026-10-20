import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  type AttachmentFileType,
  type PostContentType,
} from '@prisma/client';
import { adminNames } from '../common/admin-names';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly } from '../staff-members/kst-date';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { StorageService } from '../storage/storage.service';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import type { ListPostsDto } from './dto/list-posts.dto';
import type {
  PostListResponseDto,
  PostResponseDto,
} from './dto/post.response.dto';
import type { CreatePostDto } from './dto/create-post.dto';
import type { PostFieldsDto } from './dto/post-fields.dto';
import type { UpdatePostDto } from './dto/update-post.dto';

/** 컨트롤러가 내용으로 검사한(assertUpload) 첨부 한 개. */
export interface PostUpload {
  fileName: string;
  buffer: Buffer;
  fileType: AttachmentFileType;
  sizeBytes: number;
}

const NOT_FOUND = '게시물을 찾을 수 없습니다';
/** 공지사항 하나의 첨부 상한(운영 정책 CNT-18). DB 도 자리(sort_order) 1~5 로 막는다. */
export const MAX_POST_ATTACHMENTS = 5;
/** 첨부(10MB, 5개까지)를 트랜잭션 안에서 올린다 — 기본 5초로는 느린 업로드가 롤백된다(문의 첨부와 같다). */
const UPLOAD_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * 유형별 칸을 고른 결과. 두 갈래가 모두 같은 칸을 빠짐없이 채워야 수정 때 상대 유형의 옛 값이 남지 않는다 —
 * 칸을 더하면 여기 이름을 더해 양쪽 갈래가 컴파일에서 걸리게 한다.
 */
type PostData = Required<
  Pick<
    Prisma.PostUncheckedCreateInput,
    | 'title'
    | 'body'
    | 'status'
    | 'noticeType'
    | 'isPinned'
    | 'publishStartDate'
    | 'publishEndDate'
    | 'faqCategoryCode'
  >
>;
const PLATFORM_BP_CODE = 'BP000000';

/**
 * 공지사항 · FAQ 관리 (WHALEERP-272 · 273 노출 대상 저장 · 332 중 공지사항 · FAQ 목록). 커뮤니티 관리는
 * 플랫폼 관리자만 쓴다 — 권한은 컨트롤러가 본다.
 *
 * 변경 이력은 마지막 수정자 · 수정 시각(`updated_by` · `updated_at`)뿐이다. 상단 고정 변경도 이 수정으로
 * 남는다. 변경 전후가 필요해지면 `post_histories` 를 더한다(2026-10-12 재영 승인).
 *
 * 지우기는 지움 표시만 한다. 되살리기 API 는 아직 없다 — 행이 남아 있으니 화면이 생기면 더한다. 그래서 글을 지워도
 * 첨부(행 · 파일)는 그대로 둔다.
 *
 * 첨부는 공지사항만 받는다(FAQ 는 400, 2026-10-14 재영). 수정에서 뺀 첨부는 지움 표시하고 파일은 커밋 뒤 저장소에서
 * 지운다 — 뺀 첨부를 되살리는 길은 없어서다. 자리(sort_order)는 지우지 않은 첨부끼리 겹치지 않는 1~5 이고, 보이는
 * 순서는 올린 순서(post_attachment_id)다.
 */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  async list({
    contentType,
    status,
    page = 1,
    pageSize = 20,
  }: ListPostsDto): Promise<PostListResponseDto> {
    const where: Prisma.PostWhereInput = {
      contentType,
      isDeleted: false,
      ...(status && { status }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        select: {
          postId: true,
          contentType: true,
          title: true,
          status: true,
          noticeType: true,
          faqCategoryCode: true,
          isPinned: true,
          updatedAt: true,
          updatedBy: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { postId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.post.count({ where }),
    ]);
    const names = await adminNames(
      this.prisma,
      rows.map((r) => r.updatedBy),
    );
    return {
      total,
      items: rows.map(({ updatedBy, ...rest }) => ({
        ...rest,
        updatedByName: names.get(updatedBy) ?? null,
      })),
    };
  }

  async get(postId: number): Promise<PostResponseDto> {
    const post = await this.prisma.post.findFirst({
      where: { postId, isDeleted: false },
      include: {
        postAudiences: {
          select: { audienceType: true },
          orderBy: { postAudienceId: 'asc' },
        },
      },
    });
    if (!post) throw new NotFoundException(NOT_FOUND);
    const names = await adminNames(this.prisma, [post.updatedBy]);
    const attachments = await this.prisma.postAttachment.findMany({
      where: { postId, isDeleted: false },
      select: {
        postAttachmentId: true,
        fileName: true,
        fileType: true,
        sizeBytes: true,
      },
      orderBy: { postAttachmentId: 'asc' },
    });
    return {
      postId: post.postId,
      contentType: post.contentType,
      title: post.title,
      body: post.body,
      status: post.status,
      noticeType: post.noticeType,
      isPinned: post.isPinned,
      publishStartDate: dateText(post.publishStartDate),
      publishEndDate: dateText(post.publishEndDate),
      faqCategoryCode: post.faqCategoryCode,
      audiences: post.postAudiences.map((a) => a.audienceType),
      attachments,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      updatedBy: post.updatedBy,
      updatedByName: names.get(post.updatedBy) ?? null,
    };
  }

  async create(
    adminId: number,
    dto: CreatePostDto,
    files: readonly PostUpload[] = [],
  ): Promise<PostResponseDto> {
    assertAttachable(dto.contentType, files);
    const data = await this.fieldsOf(dto.contentType, dto);
    // 저장소가 없다는 503 은 입력 검사 뒤에 낸다 — 400 을 가리지 않게. 첨부가 없으면 저장소를 부르지 않는다.
    const storage = files.length ? requireStorage(this.storage) : null;
    const uploaded: string[] = [];
    const postId = await this.withUploads(storage, uploaded, async (tx) => {
      const { postId } = await tx.post.create({
        data: {
          contentType: dto.contentType,
          ...data,
          createdBy: adminId,
          updatedBy: adminId,
        },
        select: { postId: true },
      });
      await saveAudiences(tx, postId, dto.audiences);
      if (storage)
        await this.saveAttachments(tx, storage, postId, files, [], uploaded);
      return postId;
    });
    return this.get(postId);
  }

  /**
   * 읽은 뒤 아무도 고치지 않았을 때만 고친다. `updatedAt` 을 조건에 넣은 UPDATE 라, 동시에 두 요청이
   * 와도 PostgreSQL 이 뒤의 것을 행 잠금 뒤 다시 평가해 0 건이 된다 — 그쪽이 409 다. 첨부의 개수 · 자리는 이 행
   * 잠금을 쥔 뒤에 읽어 정하므로, 동시에 더해도 5개를 넘지 않는다.
   */
  async update(
    adminId: number,
    postId: number,
    dto: UpdatePostDto,
    files: readonly PostUpload[] = [],
  ): Promise<PostResponseDto> {
    const current = await this.prisma.post.findFirst({
      where: { postId, isDeleted: false },
      select: {
        contentType: true,
        title: true,
        body: true,
        faqCategoryCode: true,
      },
    });
    if (!current) throw new NotFoundException(NOT_FOUND);
    assertAttachable(current.contentType, files);
    const data = await this.fieldsOf(current.contentType, dto, current);
    const storage = files.length ? requireStorage(this.storage) : null;
    const removeIds = dto.removeAttachmentIds ?? [];
    const uploaded: string[] = [];
    const removedKeys = await this.withUploads(
      storage,
      uploaded,
      async (tx) => {
        const { count } = await tx.post.updateMany({
          where: {
            postId,
            isDeleted: false,
            updatedAt: sameMillisecond(dto.updatedAt),
          },
          data: { ...data, updatedBy: adminId },
        });
        if (count === 0)
          throw new ConflictException(
            '그사이 다른 관리자가 고쳤거나 지웠습니다. 다시 불러온 뒤 고쳐 주세요',
          );
        await tx.postAudience.deleteMany({ where: { postId } });
        await saveAudiences(tx, postId, dto.audiences);
        if (removeIds.length === 0 && !storage) return [];

        const live = await tx.postAttachment.findMany({
          where: { postId, isDeleted: false },
          select: { postAttachmentId: true, sortOrder: true, storageKey: true },
        });
        const liveIds = new Set(live.map((a) => a.postAttachmentId));
        if (removeIds.some((id) => !liveIds.has(id)))
          throw new BadRequestException('없는 첨부파일입니다');
        const kept = live.filter(
          (a) => !removeIds.includes(a.postAttachmentId),
        );
        if (kept.length + files.length > MAX_POST_ATTACHMENTS)
          throw new BadRequestException(
            `첨부파일은 공지사항 하나에 ${MAX_POST_ATTACHMENTS}개까지 올릴 수 있습니다`,
          );
        if (removeIds.length)
          await tx.postAttachment.updateMany({
            where: {
              postId,
              postAttachmentId: { in: removeIds },
              isDeleted: false,
            },
            data: { isDeleted: true },
          });
        if (storage)
          await this.saveAttachments(
            tx,
            storage,
            postId,
            files,
            kept.map((a) => a.sortOrder),
            uploaded,
          );
        return live
          .filter((a) => removeIds.includes(a.postAttachmentId))
          .map((a) => a.storageKey);
      },
    );
    await this.deleteFiles(postId, removedKeys);
    return this.get(postId);
  }

  async remove(adminId: number, postId: number): Promise<void> {
    const { count } = await this.prisma.post.updateMany({
      where: { postId, isDeleted: false },
      data: { isDeleted: true, updatedBy: adminId },
    });
    if (count > 0) return;
    // 되살리기가 없으니 행이 있는데 0 건이면 이미 지운 글이다. 되살리기를 더하면 isDeleted 를 보고 가른다.
    const post = await this.prisma.post.findUnique({
      where: { postId },
      select: { postId: true },
    });
    if (!post) throw new NotFoundException(NOT_FOUND);
    throw new ConflictException('이미 지운 게시물입니다');
  }

  /** 관리자의 첨부 내려받기 주소. 지운 글 · 뺀 첨부 · 다른 글의 첨부면 404. */
  async attachmentDownloadUrl(
    postId: number,
    postAttachmentId: number,
  ): Promise<DownloadUrlResponseDto> {
    const storage = requireStorage(this.storage);
    const attachment = await this.prisma.postAttachment.findFirst({
      where: {
        postAttachmentId,
        postId,
        isDeleted: false,
        post: { isDeleted: false },
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

  /**
   * 트랜잭션 안에서 첨부를 올린다. 무엇이든 실패하면 올린 파일을 지운다 — 행은 롤백돼 없으므로 남은 파일을 찾을 때
   * 쓰게 키와 원래 실패 원인을 남긴다. 시간 초과(P2028)는 장애가 아니라 다시 시도할 일이라 503 이다.
   */
  private async withUploads<T>(
    storage: StorageService | null,
    uploaded: string[],
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        work,
        storage ? { timeout: UPLOAD_TRANSACTION_TIMEOUT_MS } : undefined,
      );
    } catch (error) {
      if (storage)
        await Promise.all(
          uploaded.map((key) =>
            storage
              .delete(key, { thumbnail: false })
              .catch((e: unknown) =>
                this.logger.warn(
                  `공지 첨부 정리 실패 ${key}: ${String(e)} (cause: ${String(error)})`,
                ),
              ),
          ),
        );
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      )
        throw new ServiceUnavailableException(
          '저장이 늦어졌습니다. 잠시 뒤 다시 저장해 주세요',
        );
      throw error;
    }
  }

  /**
   * 첨부를 한꺼번에 올리고 행을 만든다. 자리는 남은 첨부(taken)가 쓰지 않는 1~5 를 앞에서부터 쓴다. 올린 키는
   * uploaded 에 쌓는다 — 실패하면 부른 쪽이 지운다. 실패 판정은 모든 업로드가 끝난 뒤에 한다(문의 첨부와 같은 까닭 —
   * 먼저 던지면 아직 올리던 파일이 정리 뒤에 끝나 아무도 모르는 파일로 남는다).
   */
  private async saveAttachments(
    tx: Prisma.TransactionClient,
    storage: StorageService,
    postId: number,
    files: readonly PostUpload[],
    taken: readonly number[],
    uploaded: string[],
  ): Promise<void> {
    const slots = [1, 2, 3, 4, 5].filter((n) => !taken.includes(n));
    const keys = files.map((f) =>
      StorageService.newKey('posts', postId, f.fileType),
    );
    uploaded.push(...keys);
    const results = await Promise.allSettled(
      files.map((f, i) => storage.put(keys[i], f.buffer, f.fileType)),
    );
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed) {
      const error: unknown = failed.reason;
      this.logger.error(
        `공지 첨부 올리기 실패 post=${postId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        '첨부파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
    await tx.postAttachment.createMany({
      data: files.map((f, i) => ({
        postId,
        fileName: f.fileName,
        fileType: f.fileType,
        sizeBytes: f.sizeBytes,
        storageKey: keys[i],
        sortOrder: slots[i],
      })),
    });
  }

  /** 뺀 첨부의 파일을 커밋 뒤에 지운다. 실패해도 수정은 성공이다 — 남은 파일을 찾게 키만 남긴다. */
  private async deleteFiles(postId: number, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (!this.storage) {
      this.logger.warn(
        `공지 첨부를 뺐지만 저장소 설정이 없어 파일을 지우지 못함 post=${postId} ${keys.join(' ')}`,
      );
      return;
    }
    const storage = this.storage;
    await Promise.all(
      keys.map((key) =>
        // 썸네일 없이 올린 파일이다 — 없는 썸네일을 지우느라 기다리지 않게 원본만 지운다.
        storage
          .delete(key, { thumbnail: false })
          .catch((e: unknown) =>
            this.logger.warn(
              `뺀 공지 첨부 파일 삭제 실패 post=${postId} ${key}: ${String(e)}`,
            ),
          ),
      ),
    );
  }

  /** 유형에 맞게 칸을 고르고 규칙을 본다. FAQ 는 공지사항 칸을 버린다(FAQ 는 게시 기간을 쓰지 않는다). */
  private async fieldsOf(
    contentType: PostContentType,
    dto: PostFieldsDto,
    current?: Pick<PostData, 'title' | 'body' | 'faqCategoryCode'>,
  ): Promise<PostData> {
    if (dto.status === 'PUBLISHED' && dto.audiences.length === 0)
      throw new BadRequestException(
        '게시하려면 노출 대상을 하나 이상 골라 주세요',
      );
    const common = { title: dto.title, body: dto.body, status: dto.status };

    if (contentType === 'FAQ') {
      if (!dto.faqCategoryCode)
        throw new BadRequestException('FAQ 카테고리를 골라 주세요');
      // 카테고리는 게시로 저장할 때와 내용(제목 · 본문 · 카테고리)을 고칠 때만 본다. 사용 중지된 카테고리의
      // FAQ 도 비공개 · 임시저장으로 내리고 지울 수는 있어야 한다(2026-10-13 재영).
      const contentChanged =
        !current ||
        current.title !== dto.title ||
        current.body !== dto.body ||
        current.faqCategoryCode !== dto.faqCategoryCode;
      if (
        (dto.status === 'PUBLISHED' || contentChanged) &&
        !(await this.isFaqCategory(dto.faqCategoryCode))
      )
        throw new BadRequestException(
          `없거나 사용 중지된 FAQ 카테고리입니다: ${dto.faqCategoryCode}`,
        );
      return {
        ...common,
        noticeType: null,
        isPinned: false,
        publishStartDate: null,
        publishEndDate: null,
        faqCategoryCode: dto.faqCategoryCode,
      };
    }

    if (!dto.noticeType)
      throw new BadRequestException('공지사항 유형을 골라 주세요');
    const start = dto.publishStartDate
      ? parseDateOnly(dto.publishStartDate)
      : null;
    const end = dto.publishEndDate ? parseDateOnly(dto.publishEndDate) : null;
    if (start && end && end < start)
      throw new BadRequestException(
        '게시 종료일이 시작일보다 앞설 수 없습니다',
      );
    return {
      ...common,
      noticeType: dto.noticeType,
      isPinned: dto.isPinned ?? false,
      publishStartDate: start,
      publishEndDate: end,
      faqCategoryCode: null,
    };
  }

  private async isFaqCategory(itemCode: string): Promise<boolean> {
    const n = await this.prisma.codeItem.count({
      where: {
        groupCode: 'FAQ_CATEGORY',
        itemCode,
        bpCode: PLATFORM_BP_CODE,
        status: 'ACTIVE',
        isDeleted: false,
        codeGroup: { status: 'ACTIVE', isDeleted: false },
      },
    });
    return n > 0;
  }
}

/** 첨부는 공지사항만 받는다(2026-10-14 재영). 개수 상한은 인터셉터가 먼저 막지만 서비스 계약으로도 지킨다. */
function assertAttachable(
  contentType: PostContentType,
  files: readonly PostUpload[],
): void {
  if (files.length === 0) return;
  if (contentType === 'FAQ')
    throw new BadRequestException('FAQ 에는 첨부파일을 올릴 수 없습니다');
  if (files.length > MAX_POST_ATTACHMENTS)
    throw new BadRequestException(
      `첨부파일은 공지사항 하나에 ${MAX_POST_ATTACHMENTS}개까지 올릴 수 있습니다`,
    );
}

async function saveAudiences(
  tx: Prisma.TransactionClient,
  postId: number,
  audiences: PostFieldsDto['audiences'],
): Promise<void> {
  if (audiences.length === 0) return;
  await tx.postAudience.createMany({
    data: audiences.map((audienceType) => ({ postId, audienceType })),
  });
}

/** 날짜만 있는 값은 UTC 자정 Date 로 온다(kst-date.ts). */
function dateText(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
