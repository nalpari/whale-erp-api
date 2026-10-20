import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { PostsService, type PostUpload } from './posts.service';
import type { CreatePostDto } from './dto/create-post.dto';
import type { UpdatePostDto } from './dto/update-post.dto';

// 규칙의 경계만 목으로 본다. 동시 수정의 409 가 실제 DB 에서도 나는지는 e2e 가 증명한다.
describe('PostsService', () => {
  let service: PostsService;
  let prisma: {
    $transaction: jest.Mock;
    post: {
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    postAudience: { deleteMany: jest.Mock; createMany: jest.Mock };
    postAttachment: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      createMany: jest.Mock;
      updateMany: jest.Mock;
    };
    codeItem: { count: jest.Mock };
    adminAccount: { findMany: jest.Mock };
  };
  let storage: { put: jest.Mock; delete: jest.Mock; downloadUrl: jest.Mock };
  let storageValue: typeof storage | null;

  const updatedAt = new Date('2026-10-13T01:02:03.456Z');
  const row = (overrides: Record<string, unknown> = {}) => ({
    postId: 7,
    contentType: 'NOTICE',
    title: '점검 안내',
    body: '본문',
    status: 'PUBLISHED',
    noticeType: 'MAINTENANCE',
    isPinned: true,
    publishStartDate: new Date('2026-10-14T00:00:00Z'),
    publishEndDate: null,
    faqCategoryCode: null,
    isDeleted: false,
    createdAt: updatedAt,
    updatedAt,
    updatedBy: 3,
    postAudiences: [{ audienceType: 'GUEST' }, { audienceType: 'BP' }],
    ...overrides,
  });

  const notice = (overrides: Partial<CreatePostDto> = {}): CreatePostDto => ({
    contentType: 'NOTICE',
    title: '점검 안내',
    body: '본문',
    status: 'PUBLISHED',
    noticeType: 'MAINTENANCE',
    isPinned: true,
    publishStartDate: '2026-10-14',
    audiences: ['GUEST', 'BP'],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as unknown[]),
      ),
      post: {
        findMany: jest.fn().mockResolvedValue([row()]),
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(row()),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn().mockResolvedValue({ postId: 7 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      postAudience: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      postAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 3, name: '김운영' }]),
      },
    };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      downloadUrl: jest.fn().mockResolvedValue('https://s3.example/signed'),
    };
    storageValue = storage;
    const module = await Test.createTestingModule({
      providers: [
        PostsService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORAGE, useFactory: () => storageValue },
      ],
    }).compile();
    service = module.get(PostsService);
  });

  describe('list', () => {
    it('지우지 않은 그 유형만, 최근 수정일 내림차순 + ID 로 준다', async () => {
      const { postId, contentType, title, status, noticeType } = row();
      prisma.post.findMany.mockResolvedValue([
        {
          ...{ postId, contentType, title, status, noticeType },
          faqCategoryCode: null,
          isPinned: true,
          updatedAt,
          updatedBy: 3,
        },
      ]);
      const result = await service.list({
        contentType: 'NOTICE',
        status: 'PUBLISHED',
        page: 2,
        pageSize: 10,
      });
      const where = {
        contentType: 'NOTICE',
        isDeleted: false,
        status: 'PUBLISHED',
      };
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ updatedAt: 'desc' }, { postId: 'desc' }],
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.post.count).toHaveBeenCalledWith({ where });
      expect(result).toEqual({
        total: 1,
        items: [
          {
            postId: 7,
            contentType: 'NOTICE',
            title: '점검 안내',
            status: 'PUBLISHED',
            noticeType: 'MAINTENANCE',
            faqCategoryCode: null,
            isPinned: true,
            updatedAt,
            updatedByName: '김운영',
          },
        ],
      });
    });

    it('상태를 주지 않으면 상태로 거르지 않는다', async () => {
      await service.list({ contentType: 'FAQ', page: 1, pageSize: 20 });
      expect(prisma.post.count).toHaveBeenCalledWith({
        where: { contentType: 'FAQ', isDeleted: false },
      });
    });
  });

  describe('get', () => {
    it('노출 대상과 수정자 이름을 담고 날짜는 YYYY-MM-DD 로 준다', async () => {
      await expect(service.get(7)).resolves.toEqual({
        postId: 7,
        contentType: 'NOTICE',
        title: '점검 안내',
        body: '본문',
        status: 'PUBLISHED',
        noticeType: 'MAINTENANCE',
        isPinned: true,
        publishStartDate: '2026-10-14',
        publishEndDate: null,
        faqCategoryCode: null,
        audiences: ['GUEST', 'BP'],
        attachments: [],
        createdAt: updatedAt,
        updatedAt,
        updatedBy: 3,
        updatedByName: '김운영',
      });
      expect(prisma.post.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { postId: 7, isDeleted: false } }),
      );
    });

    it('없거나 지운 글은 404', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.get(7)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('등록자 · 수정자를 남기고 노출 대상을 행으로 넣는다', async () => {
      await service.create(3, notice());
      expect(prisma.post.create).toHaveBeenCalledWith({
        data: {
          contentType: 'NOTICE',
          title: '점검 안내',
          body: '본문',
          status: 'PUBLISHED',
          noticeType: 'MAINTENANCE',
          isPinned: true,
          publishStartDate: new Date('2026-10-14T00:00:00Z'),
          publishEndDate: null,
          faqCategoryCode: null,
          createdBy: 3,
          updatedBy: 3,
        },
        select: { postId: true },
      });
      expect(prisma.postAudience.createMany).toHaveBeenCalledWith({
        data: [
          { postId: 7, audienceType: 'GUEST' },
          { postId: 7, audienceType: 'BP' },
        ],
      });
    });

    it('게시하려면 노출 대상이 하나 이상 있어야 한다', async () => {
      await expect(
        service.create(3, notice({ audiences: [] })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('임시저장 · 비공개는 노출 대상 없이도 된다', async () => {
      await service.create(3, notice({ status: 'DRAFT', audiences: [] }));
      await service.create(3, notice({ status: 'PRIVATE', audiences: [] }));
      expect(prisma.post.create).toHaveBeenCalledTimes(2);
      expect(prisma.postAudience.createMany).not.toHaveBeenCalled();
    });

    it('공지사항은 공지사항 유형이 있어야 한다', async () => {
      await expect(
        service.create(3, notice({ noticeType: undefined })),
      ).rejects.toThrow(BadRequestException);
    });

    it('게시 종료일이 시작일보다 앞서면 400', async () => {
      await expect(
        service.create(
          3,
          notice({
            publishStartDate: '2026-10-14',
            publishEndDate: '2026-10-13',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('종료일이 시작일과 같으면 된다 — 하루짜리 공지', async () => {
      await service.create(
        3,
        notice({
          publishStartDate: '2026-10-14',
          publishEndDate: '2026-10-14',
        }),
      );
      expect(prisma.post.create).toHaveBeenCalled();
    });

    it('종료일만 있어도 된다 — 시작일이 없으면 등록 때부터 보인다', async () => {
      await service.create(
        3,
        notice({ publishStartDate: undefined, publishEndDate: '2026-10-13' }),
      );
      expect(prisma.post.create).toHaveBeenCalled();
    });

    it('FAQ 는 카테고리가 있어야 한다 — 없으면 공통코드를 묻지도 않는다', async () => {
      await expect(
        service.create(3, {
          contentType: 'FAQ',
          title: 'Q',
          body: 'A',
          status: 'DRAFT',
          audiences: [],
        }),
      ).rejects.toThrow('FAQ 카테고리를 골라 주세요');
      expect(prisma.codeItem.count).not.toHaveBeenCalled();
    });

    it('FAQ 는 카테고리가 공통코드 FAQ_CATEGORY 에 있어야 한다', async () => {
      prisma.codeItem.count.mockResolvedValue(0);
      await expect(
        service.create(3, {
          contentType: 'FAQ',
          title: 'Q',
          body: 'A',
          status: 'DRAFT',
          faqCategoryCode: 'NOPE',
          audiences: [],
        }),
      ).rejects.toThrow('없거나 사용 중지된 FAQ 카테고리입니다');
      expect(prisma.codeItem.count).toHaveBeenCalledWith({
        where: {
          groupCode: 'FAQ_CATEGORY',
          itemCode: 'NOPE',
          bpCode: 'BP000000',
          status: 'ACTIVE',
          isDeleted: false,
          codeGroup: { status: 'ACTIVE', isDeleted: false },
        },
      });
    });

    it('FAQ 는 공지사항 칸(유형 · 상단 고정 · 게시 기간)을 버린다', async () => {
      await service.create(3, {
        contentType: 'FAQ',
        title: 'Q',
        body: 'A',
        status: 'DRAFT',
        faqCategoryCode: 'BILLING',
        noticeType: 'FEATURE',
        isPinned: true,
        publishStartDate: '2026-10-14',
        audiences: [],
      });
      expect((prisma.post.create.mock.calls[0] as [object])[0]).toMatchObject({
        data: {
          faqCategoryCode: 'BILLING',
          noticeType: null,
          isPinned: false,
          publishStartDate: null,
          publishEndDate: null,
        },
      });
    });
  });

  describe('update', () => {
    const update = (overrides: Partial<UpdatePostDto> = {}): UpdatePostDto => {
      const { title, body, status, noticeType, isPinned, publishStartDate } =
        notice();
      return {
        ...{ title, body, status, noticeType, isPinned, publishStartDate },
        audiences: ['GUEST', 'BP'],
        updatedAt: updatedAt.toISOString(),
        ...overrides,
      };
    };

    it('읽은 뒤 아무도 고치지 않았을 때만 고치고 노출 대상을 갈아 끼운다', async () => {
      await service.update(3, 7, update({ audiences: ['MEMBER'] }));
      expect(
        (prisma.post.updateMany.mock.calls[0] as [object])[0],
      ).toMatchObject({
        where: {
          postId: 7,
          isDeleted: false,
          updatedAt: {
            gte: updatedAt,
            lt: new Date(updatedAt.getTime() + 1),
          },
        },
        data: { title: '점검 안내', updatedBy: 3 },
      });
      expect(prisma.postAudience.deleteMany).toHaveBeenCalledWith({
        where: { postId: 7 },
      });
      expect(prisma.postAudience.createMany).toHaveBeenCalledWith({
        data: [{ postId: 7, audienceType: 'MEMBER' }],
      });
    });

    it('그사이 누가 고쳤으면 409', async () => {
      prisma.post.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(3, 7, update())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.postAudience.deleteMany).not.toHaveBeenCalled();
    });

    it('없거나 지운 글이면 404', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.update(3, 7, update())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('유형은 저장된 글의 것으로 판단한다 — FAQ 를 고칠 때 공지사항 유형은 요구하지 않는다', async () => {
      prisma.post.findFirst.mockResolvedValue(row({ contentType: 'FAQ' }));
      await service.update(
        3,
        7,
        update({ noticeType: undefined, faqCategoryCode: 'BILLING' }),
      );
      expect(prisma.post.updateMany).toHaveBeenCalled();
    });
  });

  describe('update — 사용 중지된 FAQ 카테고리', () => {
    const faqRow = row({
      contentType: 'FAQ',
      title: 'Q',
      body: 'A',
      status: 'PUBLISHED',
      faqCategoryCode: 'OLD',
    });
    const faqUpdate = (
      overrides: Partial<UpdatePostDto> = {},
    ): UpdatePostDto => ({
      title: 'Q',
      body: 'A',
      status: 'PRIVATE',
      faqCategoryCode: 'OLD',
      audiences: ['GUEST'],
      updatedAt: updatedAt.toISOString(),
      ...overrides,
    });

    beforeEach(() => {
      prisma.post.findFirst.mockResolvedValue(faqRow);
      prisma.codeItem.count.mockResolvedValue(0);
    });

    it('내용을 그대로 두고 비공개 · 임시저장으로만 바꾸면 카테고리를 보지 않는다', async () => {
      await service.update(3, 7, faqUpdate());
      await service.update(3, 7, faqUpdate({ status: 'DRAFT' }));
      expect(prisma.codeItem.count).not.toHaveBeenCalled();
      expect(prisma.post.updateMany).toHaveBeenCalledTimes(2);
    });

    it('게시로 저장하면 400', async () => {
      await expect(
        service.update(3, 7, faqUpdate({ status: 'PUBLISHED' })),
      ).rejects.toThrow('없거나 사용 중지된 FAQ 카테고리입니다');
    });

    it.each([{ title: 'Q2' }, { body: 'A2' }])(
      '내용(%p)을 고치면 400',
      async (changed) => {
        await expect(service.update(3, 7, faqUpdate(changed))).rejects.toThrow(
          '없거나 사용 중지된 FAQ 카테고리입니다',
        );
      },
    );
  });

  describe('remove', () => {
    it('지움 표시만 하고 수정자를 남긴다', async () => {
      await service.remove(3, 7);
      expect(prisma.post.updateMany).toHaveBeenCalledWith({
        where: { postId: 7, isDeleted: false },
        data: { isDeleted: true, updatedBy: 3 },
      });
    });

    it('이미 지운 글이면 409', async () => {
      prisma.post.updateMany.mockResolvedValue({ count: 0 });
      prisma.post.findUnique.mockResolvedValue({ isDeleted: true });
      await expect(service.remove(3, 7)).rejects.toThrow(ConflictException);
    });

    it('없는 글이면 404', async () => {
      prisma.post.updateMany.mockResolvedValue({ count: 0 });
      prisma.post.findUnique.mockResolvedValue(null);
      await expect(service.remove(3, 7)).rejects.toThrow(NotFoundException);
    });
  });

  describe('첨부파일 (WHALEERP-272)', () => {
    const png = (name = 'a.png'): PostUpload => ({
      fileName: name,
      buffer: Buffer.from('png'),
      fileType: 'PNG',
      sizeBytes: 3,
    });
    const live = (postAttachmentId: number, sortOrder: number) => ({
      postAttachmentId,
      sortOrder,
      storageKey: `posts/7/00000000-0000-4000-8000-0000000000${postAttachmentId}.pdf`,
    });
    const update = (overrides: Partial<UpdatePostDto> = {}): UpdatePostDto => {
      const { title, body, status, noticeType, isPinned, publishStartDate } =
        notice();
      return {
        ...{ title, body, status, noticeType, isPinned, publishStartDate },
        audiences: ['GUEST', 'BP'],
        updatedAt: updatedAt.toISOString(),
        ...overrides,
      };
    };
    const sortOrders = () =>
      (
        prisma.postAttachment.createMany.mock.calls[0] as [
          { data: { sortOrder: number }[] },
        ]
      )[0].data.map((d) => d.sortOrder);
    const putKeys = () =>
      storage.put.mock.calls.map((c: unknown[]) => c[0] as string);

    it('상세에 지우지 않은 첨부를 올린 순서대로 싣는다', async () => {
      const attachments = [
        {
          postAttachmentId: 11,
          fileName: '점검표.pdf',
          fileType: 'PDF',
          sizeBytes: 1234,
        },
      ];
      prisma.postAttachment.findMany.mockResolvedValue(attachments);
      await expect(service.get(7)).resolves.toMatchObject({ attachments });
      expect(prisma.postAttachment.findMany).toHaveBeenCalledWith({
        where: { postId: 7, isDeleted: false },
        select: {
          postAttachmentId: true,
          fileName: true,
          fileType: true,
          sizeBytes: true,
        },
        orderBy: { postAttachmentId: 'asc' },
      });
    });

    it('공지사항 등록은 첨부를 posts/{postId}/ 키로 올리고 자리 1부터 행을 만든다', async () => {
      await service.create(3, notice(), [png('a.png'), png('b.png')]);
      const keys = putKeys();
      expect(keys).toHaveLength(2);
      for (const key of keys)
        expect(key).toMatch(/^posts\/7\/[0-9a-f-]{36}\.png$/);
      expect(storage.put).toHaveBeenCalledWith(
        keys[0],
        expect.any(Buffer),
        'PNG',
      );
      expect(prisma.postAttachment.createMany).toHaveBeenCalledWith({
        data: [
          {
            postId: 7,
            fileName: 'a.png',
            fileType: 'PNG',
            sizeBytes: 3,
            storageKey: keys[0],
            sortOrder: 1,
          },
          {
            postId: 7,
            fileName: 'b.png',
            fileType: 'PNG',
            sizeBytes: 3,
            storageKey: keys[1],
            sortOrder: 2,
          },
        ],
      });
      // 느린 업로드가 기본 5초에 롤백되지 않게 늘린다
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 60_000,
      });
    });

    it('FAQ 에 첨부를 보내면 400 — 저장소도 DB 도 건드리지 않는다', async () => {
      await expect(
        service.create(
          3,
          {
            contentType: 'FAQ',
            title: 'Q',
            body: 'A',
            status: 'DRAFT',
            faqCategoryCode: 'BILLING',
            audiences: [],
          },
          [png()],
        ),
      ).rejects.toThrow('FAQ 에는 첨부파일을 올릴 수 없습니다');
      expect(prisma.post.create).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('첨부가 있는데 저장소 설정이 없으면 503 — 글도 만들지 않는다', async () => {
      storageValue = null;
      const module = await Test.createTestingModule({
        providers: [
          PostsService,
          { provide: PrismaService, useValue: prisma },
          { provide: STORAGE, useFactory: () => storageValue },
        ],
      }).compile();
      await expect(
        module.get(PostsService).create(3, notice(), [png()]),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('첨부를 올리다 실패하면 503 이고, 올린 파일을 지운다', async () => {
      storage.put
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('S3 down'));
      await expect(
        service.create(3, notice(), [png('a.png'), png('b.png')]),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(storage.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(
        putKeys(),
      );
      expect(prisma.postAttachment.createMany).not.toHaveBeenCalled();
    });

    it('수정에서 뺀 첨부는 지움 표시하고, 커밋 뒤 저장소에서 지운다', async () => {
      prisma.postAttachment.findMany.mockResolvedValueOnce([
        live(11, 1),
        live(12, 2),
      ]);
      await service.update(3, 7, update({ removeAttachmentIds: [12] }), []);
      expect(prisma.postAttachment.updateMany).toHaveBeenCalledWith({
        where: { postId: 7, postAttachmentId: { in: [12] }, isDeleted: false },
        data: { isDeleted: true },
      });
      expect(storage.delete).toHaveBeenCalledWith(live(12, 2).storageKey, {
        thumbnail: false,
      });
    });

    it('더한 첨부는 남은 첨부가 쓰지 않는 자리에 들어간다', async () => {
      prisma.postAttachment.findMany.mockResolvedValueOnce([
        live(11, 1),
        live(13, 3),
      ]);
      await service.update(3, 7, update(), [png('a.png'), png('b.png')]);
      expect(sortOrders()).toEqual([2, 4]);
    });

    it('남는 첨부와 더한 첨부가 5개를 넘으면 400 — 올리지 않는다', async () => {
      prisma.postAttachment.findMany.mockResolvedValueOnce([
        live(11, 1),
        live(12, 2),
        live(13, 3),
        live(14, 4),
      ]);
      await expect(
        service.update(3, 7, update(), [png('a.png'), png('b.png')]),
      ).rejects.toThrow('첨부파일은 공지사항 하나에 5개까지 올릴 수 있습니다');
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('뺀 만큼 자리가 비면 5개 안에서 더할 수 있다', async () => {
      prisma.postAttachment.findMany.mockResolvedValueOnce([
        live(11, 1),
        live(12, 2),
        live(13, 3),
        live(14, 4),
        live(15, 5),
      ]);
      await service.update(3, 7, update({ removeAttachmentIds: [12] }), [
        png(),
      ]);
      expect(sortOrders()).toEqual([2]);
    });

    it('그 공지의 지우지 않은 첨부가 아닌 ID 를 빼려 하면 400', async () => {
      prisma.postAttachment.findMany.mockResolvedValueOnce([live(11, 1)]);
      await expect(
        service.update(3, 7, update({ removeAttachmentIds: [99] }), []),
      ).rejects.toThrow('없는 첨부파일입니다');
      expect(prisma.postAttachment.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 누가 고쳤으면 409 — 첨부를 올리지 않는다', async () => {
      prisma.post.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(3, 7, update(), [png()])).rejects.toThrow(
        ConflictException,
      );
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('FAQ 수정에 첨부를 보내면 400', async () => {
      prisma.post.findFirst.mockResolvedValue(row({ contentType: 'FAQ' }));
      await expect(
        service.update(
          3,
          7,
          update({ noticeType: undefined, faqCategoryCode: 'BILLING' }),
          [png()],
        ),
      ).rejects.toThrow('FAQ 에는 첨부파일을 올릴 수 없습니다');
      expect(prisma.post.updateMany).not.toHaveBeenCalled();
    });

    it('글을 지워도 첨부는 그대로 둔다 — 글을 되살릴 수 있게', async () => {
      await service.remove(3, 7);
      expect(prisma.postAttachment.updateMany).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    describe('attachmentDownloadUrl', () => {
      it('지우지 않은 글의 지우지 않은 첨부면 원래 이름으로 받는 주소를 준다', async () => {
        prisma.postAttachment.findFirst.mockResolvedValue({
          storageKey: live(11, 1).storageKey,
          fileName: '점검표.pdf',
        });
        await expect(service.attachmentDownloadUrl(7, 11)).resolves.toEqual({
          url: 'https://s3.example/signed',
        });
        expect(prisma.postAttachment.findFirst).toHaveBeenCalledWith({
          where: {
            postAttachmentId: 11,
            postId: 7,
            isDeleted: false,
            post: { isDeleted: false },
          },
          select: { storageKey: true, fileName: true },
        });
        expect(storage.downloadUrl).toHaveBeenCalledWith(
          live(11, 1).storageKey,
          '점검표.pdf',
        );
      });

      it('없으면 404', async () => {
        await expect(service.attachmentDownloadUrl(7, 11)).rejects.toThrow(
          NotFoundException,
        );
      });
    });
  });
});
