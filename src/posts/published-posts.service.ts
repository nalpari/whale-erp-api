import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  type PostAudienceType,
  type PostContentType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import type { ListPublishedPostsDto } from './dto/list-published-posts.dto';
import type {
  PostNeighborDto,
  PublishedPostDetailResponseDto,
  PublishedPostResponseDto,
  PublishedPostListResponseDto,
  SupportPostResponseDto,
} from './dto/published-post.response.dto';

const NOT_VISIBLE = '게시가 끝났거나 볼 수 없는 게시물입니다';

/**
 * 노출 대상의 「BP」는 사업자 관리자(BP 마스터 · BP 관리자), 「점포」는 점포 단위 관리자(가맹 마스터 · 가맹 관리자),
 * 「회원」은 로그인한 모든 관리자다(목업 notice-edit 의 노출 대상 설명). 플랫폼 관리자는 회원으로만 본다.
 */
const BP_ROLES = new Set(['BM', 'BA']);
const STORE_ROLES = new Set(['FM', 'FA']);

/** 게시일 — 게시 시작일(한국 0시), 없으면 등록 일시. 정렬과 응답이 같은 기준을 쓴다. */
const POSTED_AT = Prisma.sql`COALESCE(p.publish_start_date::timestamp AT TIME ZONE 'Asia/Seoul', p.created_at)`;

/** 목록 순서 — 상단 고정 먼저, 게시일 내림차순, 같으면 post_id 내림차순. 상세의 이전 · 다음도 이 순서를 따른다. */
const LIST_ORDER = Prisma.sql`p.is_pinned DESC, ${POSTED_AT} DESC, p.post_id DESC`;

/** 부르는 사람이 드는 노출 대상. 비면 `IN ()` 이 SQL 오류(500)라 하나 이상을 타입으로 강제한다. */
export type Audiences = [PostAudienceType, ...PostAudienceType[]];

const SELECT = {
  postId: true,
  contentType: true,
  title: true,
  body: true,
  noticeType: true,
  faqCategoryCode: true,
  isPinned: true,
  publishStartDate: true,
  createdAt: true,
} as const;
type Row = Prisma.PostGetPayload<{ select: typeof SELECT }>;

/**
 * 고객지원(WHALEERP-280) · 비로그인 홈(292)의 공지사항 · FAQ 조회. 운영자 관리(PostsService)와 달리 게시된 글만,
 * 부르는 사람이 노출 대상에 든 글만, 게시 기간 안의 글만 준다.
 *
 * 노출 판정과 정렬은 SQL 한 곳(`visible` · `LIST_ORDER`)에 둔다. 게시일이 「시작일, 없으면 등록 일시」라 Prisma 의
 * orderBy 로는 쓸 수 없고, 목록 · 개수 · 상세 · 이웃이 같은 조건을 따로 적으면 서로 어긋난다.
 */
@Injectable()
export class PublishedPostsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  /** 로그인한 관리자가 드는 노출 대상. 사용 중인 계정이 아니면 null — 가드는 계정 상태를 보지 않는다. */
  async audiencesOfAdmin(adminAccountId: number): Promise<Audiences | null> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { roleTypeCode: true },
    });
    if (!admin) return null;
    const audiences: Audiences = ['MEMBER'];
    if (BP_ROLES.has(admin.roleTypeCode)) audiences.push('BP');
    if (STORE_ROLES.has(admin.roleTypeCode)) audiences.push('STORE');
    return audiences;
  }

  async list(
    audiences: Audiences,
    contentType: PostContentType,
    {
      noticeType,
      faqCategoryCode,
      keyword,
      page = 1,
      pageSize = 20,
    }: ListPublishedPostsDto,
  ): Promise<PublishedPostListResponseDto> {
    const filters = [Prisma.sql`p.content_type::text = ${contentType}`];
    if (noticeType)
      filters.push(Prisma.sql`p.notice_type::text = ${noticeType}`);
    if (faqCategoryCode)
      filters.push(Prisma.sql`p.faq_category_code = ${faqCategoryCode}`);
    // LIKE 가 아니라 strpos 라 % · _ 를 이스케이프하지 않아도 글자 그대로 찾는다. 공지사항은 제목만(#282 「제목
    // 검색」 — 같은 list 를 쓰는 비로그인 /public-notices 도 같다), FAQ 는 질문(제목) · 답변(본문)을 함께 찾는다.
    if (keyword)
      filters.push(
        contentType === 'NOTICE'
          ? Prisma.sql`strpos(lower(p.title), lower(${keyword})) > 0`
          : Prisma.sql`(strpos(lower(p.title), lower(${keyword})) > 0 OR strpos(lower(p.body), lower(${keyword})) > 0)`,
      );
    const where = visible(audiences, filters);

    const [ids, [{ total }]] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ post_id: number }[]>`
        SELECT p.post_id FROM posts p WHERE ${where}
        ORDER BY ${LIST_ORDER}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
    ]);
    if (ids.length === 0) return { items: [], total };

    const rows = await this.prisma.post.findMany({
      // 지움 표시만 다시 본다. 고른 뒤 상태 · 대상이 바뀐 글과 total 은 맞추지 않는다 — 목록과 count 가 다른
      // 스냅샷을 읽는 것과 같은 허용이다(네이밍 규칙 「API list responses」).
      where: { postId: { in: ids.map((r) => r.post_id) }, isDeleted: false },
      select: SELECT,
    });
    const byId = new Map(rows.map((r) => [r.postId, r]));
    return {
      total,
      items: ids.flatMap(({ post_id }) => {
        const r = byId.get(post_id);
        return r ? [toDto(r)] : [];
      }),
    };
  }

  /**
   * 비공개 · 임시저장 · 지움 · 기간 밖 · 노출 대상 밖 · 경로와 다른 글 종류면 404 — 어느 것인지는 밝히지 않는다.
   * 공지사항이면 지우지 않은 첨부를 올린 순서대로 싣는다(#282 · #293).
   */
  async get(
    audiences: Audiences,
    contentType: PostContentType,
    postId: number,
  ): Promise<PublishedPostDetailResponseDto> {
    const hit = await this.prisma.$queryRaw<{ post_id: number }[]>`
      SELECT p.post_id FROM posts p
      WHERE ${visible(audiences, [Prisma.sql`p.post_id = ${postId}`, Prisma.sql`p.content_type::text = ${contentType}`])}`;
    if (hit.length === 0) throw new NotFoundException(NOT_VISIBLE);
    const [row] = await this.prisma.post.findMany({
      where: { postId, isDeleted: false },
      select: SELECT,
    });
    if (!row) throw new NotFoundException(NOT_VISIBLE);
    const attachments =
      row.contentType === 'NOTICE'
        ? await this.prisma.postAttachment.findMany({
            where: { postId, isDeleted: false },
            select: {
              postAttachmentId: true,
              fileName: true,
              fileType: true,
              sizeBytes: true,
            },
            orderBy: { postAttachmentId: 'asc' },
          })
        : [];
    return { ...toDto(row), attachments };
  }

  /**
   * 첨부 내려받기 주소(#280 · #292). 그 사람에게 보이는 공지사항(상세와 같은 판정)의 지우지 않은 첨부만 준다 —
   * 아니면 어느 까닭인지 밝히지 않고 404. 저장소 설정이 없으면 묻기 전에 503.
   */
  async attachmentDownloadUrl(
    audiences: Audiences,
    postId: number,
    postAttachmentId: number,
  ): Promise<DownloadUrlResponseDto> {
    const storage = requireStorage(this.storage);
    const hit = await this.prisma.$queryRaw<{ post_id: number }[]>`
      SELECT p.post_id FROM posts p
      WHERE ${visible(audiences, [Prisma.sql`p.post_id = ${postId}`, Prisma.sql`p.content_type = 'NOTICE'`])}`;
    const attachment =
      hit.length === 0
        ? null
        : await this.prisma.postAttachment.findFirst({
            where: { postAttachmentId, postId, isDeleted: false },
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
   * 공지사항 상세의 이전 · 다음(#282). 그 사람에게 보이는 공지사항을 목록 순서(`LIST_ORDER`)로 늘어놓았을 때
   * 바로 아래(이전)와 바로 위(다음) 글이다. 목록의 구분 · 검색어 필터는 걸지 않는다. 기준 글이 보이지 않으면 둘 다 null.
   */
  async neighbors(
    audiences: Audiences,
    postId: number,
  ): Promise<Pick<SupportPostResponseDto, 'prev' | 'next'>> {
    const [hit] = await this.prisma.$queryRaw<
      { older_id: number | null; newer_id: number | null }[]
    >`
      SELECT older_id, newer_id FROM (
        SELECT p.post_id,
          lead(p.post_id) OVER (ORDER BY ${LIST_ORDER}) AS older_id,
          lag(p.post_id) OVER (ORDER BY ${LIST_ORDER}) AS newer_id
        FROM posts p WHERE ${visible(audiences, [Prisma.sql`p.content_type = 'NOTICE'`])}
      ) t WHERE t.post_id = ${postId}`;
    const ids = [hit?.older_id, hit?.newer_id].filter(
      (id): id is number => id != null,
    );
    if (ids.length === 0) return { prev: null, next: null };

    const rows = await this.prisma.post.findMany({
      where: { postId: { in: ids }, isDeleted: false },
      select: SELECT,
    });
    const byId = new Map(rows.map((r) => [r.postId, r]));
    const neighbor = (
      id: number | null | undefined,
    ): PostNeighborDto | null => {
      const r = id == null ? undefined : byId.get(id);
      return r
        ? { postId: r.postId, title: r.title, postedDate: toDto(r).postedDate }
        : null;
    };
    return { prev: neighbor(hit.older_id), next: neighbor(hit.newer_id) };
  }
}

/**
 * 사용자에게 보이는 글: 게시 상태, 지우지 않음, 노출 대상에 듦, 게시 기간 안(한국 날짜, 종료일 그날까지).
 * FAQ 는 게시 기간 칸이 늘 비어 있어 기간 조건이 걸리지 않는다.
 */
function visible(audiences: Audiences, extra: Prisma.Sql[]): Prisma.Sql {
  const today = kstToday().toISOString().slice(0, 10);
  return Prisma.join(
    [
      Prisma.sql`p.status = 'PUBLISHED'`,
      Prisma.sql`NOT p.is_deleted`,
      Prisma.sql`(p.publish_start_date IS NULL OR p.publish_start_date <= ${today}::date)`,
      Prisma.sql`(p.publish_end_date IS NULL OR p.publish_end_date >= ${today}::date)`,
      Prisma.sql`EXISTS (SELECT 1 FROM post_audiences a WHERE a.post_id = p.post_id AND a.audience_type::text IN (${Prisma.join(audiences)}))`,
      ...extra,
    ],
    ' AND ',
  );
}

function toDto(r: Row): PublishedPostResponseDto {
  return {
    postId: r.postId,
    contentType: r.contentType,
    title: r.title,
    body: r.body,
    noticeType: r.noticeType,
    faqCategoryCode: r.faqCategoryCode,
    isPinned: r.isPinned,
    // 날짜만 있는 값은 UTC 자정 Date 로 온다(kst-date.ts). 등록 일시는 한국 날짜로 바꾼다.
    postedDate: (r.publishStartDate ?? kstToday(r.createdAt))
      .toISOString()
      .slice(0, 10),
  };
}
