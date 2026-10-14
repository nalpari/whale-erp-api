import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PostContentType, Prisma } from '@prisma/client';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly } from '../staff-members/kst-date';
import type { ListPostsDto } from './dto/list-posts.dto';
import type {
  PostListResponseDto,
  PostResponseDto,
} from './dto/post.response.dto';
import type { CreatePostDto } from './dto/create-post.dto';
import type { PostFieldsDto } from './dto/post-fields.dto';
import type { UpdatePostDto } from './dto/update-post.dto';

const NOT_FOUND = '게시물을 찾을 수 없습니다';

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
 * 지우기는 지움 표시만 한다. 되살리기 API 는 아직 없다 — 행이 남아 있으니 화면이 생기면 더한다.
 */
@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const names = await this.adminNames(rows.map((r) => r.updatedBy));
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
    const names = await this.adminNames([post.updatedBy]);
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
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      updatedBy: post.updatedBy,
      updatedByName: names.get(post.updatedBy) ?? null,
    };
  }

  async create(adminId: number, dto: CreatePostDto): Promise<PostResponseDto> {
    const data = await this.fieldsOf(dto.contentType, dto);
    const postId = await this.prisma.$transaction(async (tx) => {
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
      return postId;
    });
    return this.get(postId);
  }

  /**
   * 읽은 뒤 아무도 고치지 않았을 때만 고친다. `updatedAt` 을 조건에 넣은 UPDATE 라, 동시에 두 요청이
   * 와도 PostgreSQL 이 뒤의 것을 행 잠금 뒤 다시 평가해 0 건이 된다 — 그쪽이 409 다.
   */
  async update(
    adminId: number,
    postId: number,
    dto: UpdatePostDto,
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
    const data = await this.fieldsOf(current.contentType, dto, current);
    await this.prisma.$transaction(async (tx) => {
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
    });
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

  /** posts 는 관리자 계정과 Prisma 관계가 없어(팀 경계) 이름을 따로 읽는다. */
  private async adminNames(
    ids: (number | null)[],
  ): Promise<Map<number | null, string | null>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    const admins = await this.prisma.adminAccount.findMany({
      where: { adminAccountId: { in: wanted } },
      select: { adminAccountId: true, name: true },
    });
    return new Map(admins.map((a) => [a.adminAccountId, a.name]));
  }
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
