import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
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
  let permissions: { assert: jest.Mock };
  const admin: AuthUser = { type: 'admin', id: 3, loginId: 'bpadmin', sid: 1 };
  const query = { contentType: 'NOTICE' as const, page: 1, pageSize: 20 };

  beforeEach(async () => {
    service = {
      audiencesOfAdmin: jest.fn(),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      get: jest.fn().mockResolvedValue({ postId: 5, contentType: 'NOTICE' }),
    };
    permissions = { assert: jest.fn().mockResolvedValue({}) };
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicPostsController, SupportPostsController],
      providers: [
        { provide: PublishedPostsService, useValue: service },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
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

  // 한 경로가 공지사항 · FAQ 를 함께 주므로 글 종류마다 그 메뉴의 조회 권한으로 판정한다(재영 결정 2026-10-15, #280).
  it.each([
    ['NOTICE', 'MN000035'],
    ['FAQ', 'MN000043'],
  ] as const)(
    '%s 목록은 %s 조회 권한으로 판정한다',
    async (contentType, menu) => {
      service.audiencesOfAdmin.mockResolvedValue(['MEMBER']);
      await supportPosts.list(admin, { ...query, contentType });
      expect(permissions.assert).toHaveBeenCalledWith(3, menu, 'read');
    },
  );

  it.each([
    ['NOTICE', 'MN000035'],
    ['FAQ', 'MN000043'],
  ] as const)(
    '%s 상세는 글을 읽어 종류를 안 뒤 %s 조회 권한으로 판정한다',
    async (contentType, menu) => {
      service.audiencesOfAdmin.mockResolvedValue(['MEMBER']);
      service.get.mockResolvedValue({ postId: 5, contentType });
      await supportPosts.get(admin, '5');
      expect(permissions.assert).toHaveBeenCalledWith(3, menu, 'read');
    },
  );

  it('메뉴 조회 권한이 없으면 목록은 묻기 전에, 상세는 글을 주지 않고 403', async () => {
    service.audiencesOfAdmin.mockResolvedValue(['MEMBER']);
    permissions.assert.mockRejectedValue(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
    await expect(supportPosts.list(admin, query)).rejects.toThrow(
      ACCESS_DENIED_MESSAGE,
    );
    expect(service.list).not.toHaveBeenCalled();
    await expect(supportPosts.get(admin, '5')).rejects.toThrow(
      ACCESS_DENIED_MESSAGE,
    );
  });

  it('사용 중이 아닌 관리자는 목록 · 상세 모두 「사용할 수 없는 계정」 403', async () => {
    service.audiencesOfAdmin.mockResolvedValue(null);
    for (const call of [
      () => supportPosts.list(admin, query),
      () => supportPosts.get(admin, '5'),
    ]) {
      await expect(call()).rejects.toThrow(ForbiddenException);
      await expect(call()).rejects.toThrow(ACCOUNT_UNAVAILABLE_MESSAGE);
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
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
