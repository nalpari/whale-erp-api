import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PublishedPostsService } from './published-posts.service';

// 노출 판정(노출 대상 · 게시 상태 · 게시 기간)과 정렬은 SQL 이라 목으로는 모양만 본다 — 실제로 걸러지는지는
// test/published-posts.e2e-spec.ts 가 증명한다. 여기서는 역할 → 노출 대상, 순서 보존, 게시일 계산을 본다.
describe('PublishedPostsService', () => {
  let service: PublishedPostsService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    post: { findMany: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
  };

  const row = (postId: number, overrides: Record<string, unknown> = {}) => ({
    postId,
    contentType: 'NOTICE',
    title: `글 ${postId}`,
    body: '본문',
    noticeType: 'GENERAL',
    faqCategoryCode: null,
    isPinned: false,
    publishStartDate: null,
    // 한국 시간 10월 15일 오전 8시 — UTC 로는 14일이다.
    createdAt: new Date('2026-10-14T23:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((queries: unknown[]) => Promise.all(queries)),
      $queryRaw: jest.fn(),
      post: { findMany: jest.fn() },
      adminAccount: { findFirst: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PublishedPostsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(PublishedPostsService);
  });

  describe('audiencesOfAdmin — 로그인한 관리자가 드는 노출 대상', () => {
    it.each([
      ['PM', ['MEMBER']],
      ['PA', ['MEMBER']],
      ['BM', ['MEMBER', 'BP']],
      ['BA', ['MEMBER', 'BP']],
      ['FM', ['MEMBER', 'STORE']],
      ['FA', ['MEMBER', 'STORE']],
    ])('%s 는 %j', async (roleTypeCode, expected) => {
      prisma.adminAccount.findFirst.mockResolvedValue({ roleTypeCode });
      await expect(service.audiencesOfAdmin(3)).resolves.toEqual(expected);
    });

    it('사용 중이 아니거나 없는 계정이면 null', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.audiencesOfAdmin(3)).resolves.toBeNull();
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
          }) as unknown,
        }),
      );
    });
  });

  describe('list', () => {
    it('SQL 이 정한 순서를 지키고 total 을 준다', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ post_id: 9 }, { post_id: 4 }])
        .mockResolvedValueOnce([{ total: 12 }]);
      // findMany 는 순서를 보장하지 않는다.
      prisma.post.findMany.mockResolvedValue([row(4), row(9)]);

      const res = await service.list(['GUEST'], {
        contentType: 'NOTICE',
        page: 1,
        pageSize: 20,
      });

      expect(res.total).toBe(12);
      expect(res.items.map((i) => i.postId)).toEqual([9, 4]);
    });

    it('다시 읽을 때 지움 표시를 보고, 그 사이 지워진 글은 뺀다', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ post_id: 9 }, { post_id: 4 }])
        .mockResolvedValueOnce([{ total: 2 }]);
      prisma.post.findMany.mockResolvedValue([row(4)]);

      const res = await service.list(['GUEST'], {
        contentType: 'NOTICE',
        page: 1,
        pageSize: 20,
      });

      expect(res.items.map((i) => i.postId)).toEqual([4]);
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { postId: { in: [9, 4] }, isDeleted: false },
        }),
      );
    });

    it('빈 쪽이면 findMany 없이 { items: [], total }', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 3 }]);

      await expect(
        service.list(['GUEST'], { contentType: 'FAQ', page: 9, pageSize: 20 }),
      ).resolves.toEqual({ items: [], total: 3 });
      expect(prisma.post.findMany).not.toHaveBeenCalled();
    });

    it('게시일은 게시 시작일, 없으면 등록 일시의 한국 날짜', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ post_id: 1 }, { post_id: 2 }])
        .mockResolvedValueOnce([{ total: 2 }]);
      prisma.post.findMany.mockResolvedValue([
        row(1, { publishStartDate: new Date('2026-10-20T00:00:00Z') }),
        row(2),
      ]);

      const { items } = await service.list(['MEMBER'], {
        contentType: 'NOTICE',
        page: 1,
        pageSize: 20,
      });

      expect(items.map((i) => i.postedDate)).toEqual([
        '2026-10-20',
        '2026-10-15',
      ]);
    });
  });

  describe('get', () => {
    it('보이는 글이면 준다', async () => {
      prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
      prisma.post.findMany.mockResolvedValue([
        row(5, { contentType: 'FAQ', faqCategoryCode: 'ACCOUNT' }),
      ]);

      await expect(service.get(['GUEST'], 5)).resolves.toMatchObject({
        postId: 5,
        contentType: 'FAQ',
        faqCategoryCode: 'ACCOUNT',
        postedDate: '2026-10-15',
      });
    });

    it('판정 뒤 다시 읽을 때 지워졌으면 404', async () => {
      prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
      prisma.post.findMany.mockResolvedValue([]);
      await expect(service.get(['GUEST'], 5)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { postId: 5, isDeleted: false } }),
      );
    });

    it('오늘은 한국 날짜로 정한다 — UTC 15시 이후는 한국의 다음 날', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-14T15:30:00Z'));
      try {
        prisma.$queryRaw.mockResolvedValue([]);
        await service.get(['GUEST'], 5).catch(() => undefined);
        // 태그 템플릿이라 [문자열 조각, ...값] 으로 불린다. 값 가운데 Prisma.Sql 조각은 자기 값을 펼쳐 담는다.
        const values = (prisma.$queryRaw.mock.calls[0] as unknown[])
          .slice(1)
          .flatMap((v) => (v as { values?: unknown[] }).values ?? [v]);
        expect(values).toContain('2026-10-15');
        expect(values).not.toContain('2026-10-14');
      } finally {
        jest.useRealTimers();
      }
    });

    it('비공개 · 지움 · 기간 밖 · 노출 대상 밖이면 404', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.get(['GUEST'], 5)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // 어느 글이 이웃인지(보이는 글 안에서, 목록 순서대로)는 SQL 이라 e2e 가 증명한다. 여기서는 모양만 본다.
  describe('neighbors — 공지사항 상세의 이전 · 다음', () => {
    it('이전은 목록에서 바로 아래(더 오래된) 글, 다음은 바로 위 글', async () => {
      prisma.$queryRaw.mockResolvedValue([{ older_id: 4, newer_id: 9 }]);
      prisma.post.findMany.mockResolvedValue([
        row(9, { title: '새 글' }),
        row(4, {
          title: '옛 글',
          publishStartDate: new Date('2026-09-01T00:00:00Z'),
        }),
      ]);

      await expect(service.neighbors(['MEMBER'], 5)).resolves.toEqual({
        prev: { postId: 4, title: '옛 글', postedDate: '2026-09-01' },
        next: { postId: 9, title: '새 글', postedDate: '2026-10-15' },
      });
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { postId: { in: [4, 9] }, isDeleted: false },
        }),
      );
    });

    it('맨 끝이면 그쪽은 null 이고, 둘 다 없으면 다시 읽지 않는다', async () => {
      prisma.$queryRaw.mockResolvedValue([{ older_id: null, newer_id: null }]);
      await expect(service.neighbors(['MEMBER'], 5)).resolves.toEqual({
        prev: null,
        next: null,
      });
      expect(prisma.post.findMany).not.toHaveBeenCalled();
    });

    it('그 사이 지워진 이웃은 null', async () => {
      prisma.$queryRaw.mockResolvedValue([{ older_id: 4, newer_id: 9 }]);
      prisma.post.findMany.mockResolvedValue([row(9)]);
      await expect(service.neighbors(['MEMBER'], 5)).resolves.toMatchObject({
        prev: null,
        next: { postId: 9 },
      });
    });

    it('기준 글이 보이지 않으면(행 없음) 둘 다 null', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.neighbors(['MEMBER'], 5)).resolves.toEqual({
        prev: null,
        next: null,
      });
    });
  });
});
