import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { PublishedPostsService } from './published-posts.service';

// 노출 판정(노출 대상 · 게시 상태 · 게시 기간)과 정렬은 SQL 이라 목으로는 모양만 본다 — 실제로 걸러지는지는
// test/published-posts.e2e-spec.ts 가 증명한다. 여기서는 역할 → 노출 대상, 순서 보존, 게시일 계산을 본다.
describe('PublishedPostsService', () => {
  let service: PublishedPostsService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    post: { findMany: jest.Mock };
    postAttachment: { findMany: jest.Mock; findFirst: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
  };
  let storage: { downloadUrl: jest.Mock } | null;

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
      postAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      adminAccount: { findFirst: jest.fn() },
    };
    storage = {
      downloadUrl: jest.fn().mockResolvedValue('https://s3.example/signed'),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PublishedPostsService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORAGE, useFactory: () => storage },
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

  // 「보이는 글의 첨부만」은 SQL 판정이라 e2e 가 증명한다. 여기서는 순서와 막는 자리를 본다(WHALEERP-280 · 292).
  describe('첨부파일', () => {
    const attachments = [
      {
        postAttachmentId: 11,
        fileName: '점검표.pdf',
        fileType: 'PDF',
        sizeBytes: 1234,
      },
    ];

    it('공지사항 상세에 지우지 않은 첨부를 올린 순서대로 싣는다', async () => {
      prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
      prisma.post.findMany.mockResolvedValue([row(5)]);
      prisma.postAttachment.findMany.mockResolvedValue(attachments);
      await expect(service.get(['GUEST'], 5)).resolves.toMatchObject({
        attachments,
      });
      expect(prisma.postAttachment.findMany).toHaveBeenCalledWith({
        where: { postId: 5, isDeleted: false },
        select: {
          postAttachmentId: true,
          fileName: true,
          fileType: true,
          sizeBytes: true,
        },
        orderBy: { postAttachmentId: 'asc' },
      });
    });

    it('FAQ 상세는 첨부를 읽지 않고 빈 목록', async () => {
      prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
      prisma.post.findMany.mockResolvedValue([row(5, { contentType: 'FAQ' })]);
      await expect(service.get(['GUEST'], 5)).resolves.toMatchObject({
        attachments: [],
      });
      expect(prisma.postAttachment.findMany).not.toHaveBeenCalled();
    });

    describe('attachmentDownloadUrl', () => {
      it('보이는 공지사항의 지우지 않은 첨부면 원래 이름으로 받는 주소를 준다', async () => {
        prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
        prisma.postAttachment.findFirst.mockResolvedValue({
          storageKey: 'posts/5/k.pdf',
          fileName: '점검표.pdf',
        });
        await expect(
          service.attachmentDownloadUrl(['GUEST'], 5, 11),
        ).resolves.toEqual({ url: 'https://s3.example/signed' });
        expect(prisma.postAttachment.findFirst).toHaveBeenCalledWith({
          where: { postAttachmentId: 11, postId: 5, isDeleted: false },
          select: { storageKey: true, fileName: true },
        });
        expect(storage!.downloadUrl).toHaveBeenCalledWith(
          'posts/5/k.pdf',
          '점검표.pdf',
        );
      });

      it('글이 보이지 않으면 첨부를 찾지 않고 404', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        await expect(
          service.attachmentDownloadUrl(['GUEST'], 5, 11),
        ).rejects.toThrow(NotFoundException);
        expect(prisma.postAttachment.findFirst).not.toHaveBeenCalled();
      });

      it('그 글의 지우지 않은 첨부가 아니면 404', async () => {
        prisma.$queryRaw.mockResolvedValue([{ post_id: 5 }]);
        await expect(
          service.attachmentDownloadUrl(['GUEST'], 5, 11),
        ).rejects.toThrow(NotFoundException);
      });

      it('저장소 설정이 없으면 묻기 전에 503', async () => {
        storage = null;
        const moduleRef = await Test.createTestingModule({
          providers: [
            PublishedPostsService,
            { provide: PrismaService, useValue: prisma },
            { provide: STORAGE, useFactory: () => storage },
          ],
        }).compile();
        await expect(
          moduleRef
            .get(PublishedPostsService)
            .attachmentDownloadUrl(['GUEST'], 5, 11),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });
    });
  });
});
