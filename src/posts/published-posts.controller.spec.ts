import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import { PublicPostsController } from './public-posts.controller';
import { PublishedPostsService } from './published-posts.service';
import { SupportPostsController } from './support-posts.controller';

describe('공개 · 고객지원 공지사항 · FAQ 컨트롤러', () => {
  let publicPosts: PublicPostsController;
  let supportPosts: SupportPostsController;
  let service: {
    audiencesOfAdmin: jest.Mock;
    list: jest.Mock;
    get: jest.Mock;
  };
  const admin: AuthUser = { type: 'admin', id: 3, loginId: 'bpadmin', sid: 1 };
  const query = { contentType: 'NOTICE' as const, page: 1, pageSize: 20 };

  beforeEach(async () => {
    service = {
      audiencesOfAdmin: jest.fn(),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      get: jest.fn().mockResolvedValue({ postId: 5 }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicPostsController, SupportPostsController],
      providers: [{ provide: PublishedPostsService, useValue: service }],
    }).compile();
    publicPosts = moduleRef.get(PublicPostsController);
    supportPosts = moduleRef.get(SupportPostsController);
  });

  it('비로그인은 비회원 대상으로 묻는다', async () => {
    await publicPosts.list(query);
    await publicPosts.get('5');
    expect(service.list).toHaveBeenCalledWith(['GUEST'], query);
    expect(service.get).toHaveBeenCalledWith(['GUEST'], 5);
  });

  it('고객지원은 그 관리자가 드는 노출 대상으로 묻는다', async () => {
    service.audiencesOfAdmin.mockResolvedValue(['MEMBER', 'BP']);
    await supportPosts.list(admin, query);
    await supportPosts.get(admin, '5');
    expect(service.list).toHaveBeenCalledWith(['MEMBER', 'BP'], query);
    expect(service.get).toHaveBeenCalledWith(['MEMBER', 'BP'], 5);
  });

  it('사용 중이 아닌 관리자는 403', async () => {
    service.audiencesOfAdmin.mockResolvedValue(null);
    await expect(supportPosts.list(admin, query)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it.each(['abc', '0', '2147483648'])(
    '범위 밖 ID %s 는 묻기 전에 404',
    async (raw) => {
      await expect(publicPosts.get(raw)).rejects.toThrow(NotFoundException);
      await expect(supportPosts.get(admin, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(service.get).not.toHaveBeenCalled();
    },
  );
});
