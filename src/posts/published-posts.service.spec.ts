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

    it('비공개 · 지움 · 기간 밖 · 노출 대상 밖이면 404', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.get(['GUEST'], 5)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
