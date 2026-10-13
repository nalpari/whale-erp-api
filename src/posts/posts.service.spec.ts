import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from './posts.service';
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
    codeItem: { count: jest.Mock };
    adminAccount: { findMany: jest.Mock };
  };

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
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 3, name: '김운영' }]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [PostsService, { provide: PrismaService, useValue: prisma }],
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

    it('종료일만 있어도 된다 — 시작일이 없으면 등록 때부터 보인다', async () => {
      await service.create(
        3,
        notice({ publishStartDate: undefined, publishEndDate: '2026-10-13' }),
      );
      expect(prisma.post.create).toHaveBeenCalled();
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
      ).rejects.toThrow(BadRequestException);
      expect(prisma.codeItem.count).toHaveBeenCalledWith({
        where: {
          groupCode: 'FAQ_CATEGORY',
          itemCode: 'NOPE',
          bpCode: 'BP000000',
          status: 'ACTIVE',
          isDeleted: false,
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
});
