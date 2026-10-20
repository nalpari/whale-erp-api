import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import {
  PublicFaqsController,
  PublicNoticesController,
} from './public-posts.controller';
import { PublishedPostsService } from './published-posts.service';
import {
  SupportFaqsController,
  SupportNoticesController,
} from './support-posts.controller';

const permissionOf = (cls: { prototype: object }, name: string) =>
  Reflect.getMetadata(
    MENU_PERMISSION,
    Object.getOwnPropertyDescriptor(cls.prototype, name)!.value as object,
  ) as unknown;

describe('공개 · 고객지원 공지사항 · FAQ 컨트롤러', () => {
  let publicNotices: PublicNoticesController;
  let publicFaqs: PublicFaqsController;
  let supportNotices: SupportNoticesController;
  let supportFaqs: SupportFaqsController;
  let service: {
    audiencesOfAdmin: jest.Mock;
    list: jest.Mock;
    get: jest.Mock;
    neighbors: jest.Mock;
    attachmentDownloadUrl: jest.Mock;
  };
  const admin: AuthUser = { type: 'admin', id: 3, loginId: 'bpadmin', sid: 1 };
  const query = { page: 1, pageSize: 20 };

  beforeEach(async () => {
    service = {
      audiencesOfAdmin: jest.fn(),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      get: jest.fn().mockResolvedValue({ postId: 5, contentType: 'NOTICE' }),
      neighbors: jest.fn().mockResolvedValue({ prev: null, next: null }),
      attachmentDownloadUrl: jest.fn().mockResolvedValue({ url: 'u' }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PublicNoticesController,
        PublicFaqsController,
        SupportNoticesController,
        SupportFaqsController,
      ],
      providers: [{ provide: PublishedPostsService, useValue: service }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    publicNotices = moduleRef.get(PublicNoticesController);
    publicFaqs = moduleRef.get(PublicFaqsController);
    supportNotices = moduleRef.get(SupportNoticesController);
    supportFaqs = moduleRef.get(SupportFaqsController);
  });

  // 관리자 웹은 메뉴 권한을 화면 경로로 판정해 경로마다 그 메뉴의 조회 권한을 본다(WHALEERP-596).
  it('고객지원 공지사항은 MN000035, FAQ 는 MN000043 조회 권한 가드', () => {
    for (const name of ['list', 'get', 'attachmentDownloadUrl'])
      expect([name, permissionOf(SupportNoticesController, name)]).toEqual([
        name,
        { menuCode: 'MN000035', action: 'read' },
      ]);
    expect(permissionOf(SupportFaqsController, 'list')).toEqual({
      menuCode: 'MN000043',
      action: 'read',
    });
  });

  it('비로그인은 비회원 대상과 경로의 글 종류로 묻는다', async () => {
    await publicNotices.list(query);
    await publicNotices.get('5');
    await publicFaqs.list(query);
    expect(service.list).toHaveBeenCalledWith(['GUEST'], 'NOTICE', query);
    expect(service.get).toHaveBeenCalledWith(['GUEST'], 'NOTICE', 5);
    expect(service.list).toHaveBeenCalledWith(['GUEST'], 'FAQ', query);
  });

  it('고객지원은 그 관리자가 드는 노출 대상과 경로의 글 종류로 묻는다', async () => {
    service.audiencesOfAdmin.mockResolvedValue(['MEMBER', 'BP']);
    await supportNotices.list(admin, query);
    await supportNotices.get(admin, '5');
    await supportFaqs.list(admin, query);
    expect(service.list).toHaveBeenCalledWith(
      ['MEMBER', 'BP'],
      'NOTICE',
      query,
    );
    expect(service.get).toHaveBeenCalledWith(['MEMBER', 'BP'], 'NOTICE', 5);
    expect(service.list).toHaveBeenCalledWith(['MEMBER', 'BP'], 'FAQ', query);
  });

  it('고객지원 공지사항 상세는 이전 · 다음을 함께 준다(#282)', async () => {
    service.audiencesOfAdmin.mockResolvedValue(['MEMBER', 'BP']);
    const prev = { postId: 4, title: '옛 글', postedDate: '2026-09-01' };
    service.neighbors.mockResolvedValue({ prev, next: null });

    await expect(supportNotices.get(admin, '5')).resolves.toEqual({
      postId: 5,
      contentType: 'NOTICE',
      prev,
      next: null,
    });
    expect(service.neighbors).toHaveBeenCalledWith(['MEMBER', 'BP'], 5);
  });

  it('가드 뒤 그 사이 막힌 관리자는 목록 · 상세 · 내려받기 모두 「사용할 수 없는 계정」 403', async () => {
    service.audiencesOfAdmin.mockResolvedValue(null);
    for (const call of [
      () => supportNotices.list(admin, query),
      () => supportNotices.get(admin, '5'),
      () => supportNotices.attachmentDownloadUrl(admin, '5', '11'),
      () => supportFaqs.list(admin, query),
    ]) {
      await expect(call()).rejects.toThrow(ForbiddenException);
      await expect(call()).rejects.toThrow(ACCOUNT_UNAVAILABLE_MESSAGE);
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
    expect(service.attachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '2147483648'])(
    '범위 밖 ID %s 는 묻기 전에 404',
    async (raw) => {
      await expect(publicNotices.get(raw)).rejects.toThrow(NotFoundException);
      await expect(supportNotices.get(admin, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(service.get).not.toHaveBeenCalled();
    },
  );

  describe('첨부 내려받기 주소 (WHALEERP-280 · 292)', () => {
    it('비로그인은 비회원 대상으로 묻는다', async () => {
      await publicNotices.attachmentDownloadUrl('5', '11');
      expect(service.attachmentDownloadUrl).toHaveBeenCalledWith(
        ['GUEST'],
        5,
        11,
      );
    });

    it('고객지원은 그 관리자의 노출 대상으로 묻는다', async () => {
      service.audiencesOfAdmin.mockResolvedValue(['MEMBER', 'BP']);
      await supportNotices.attachmentDownloadUrl(admin, '5', '11');
      expect(service.attachmentDownloadUrl).toHaveBeenCalledWith(
        ['MEMBER', 'BP'],
        5,
        11,
      );
    });

    it.each([
      ['abc', '11'],
      ['5', '0'],
      ['5', '2147483648'],
    ])('범위 밖 ID (%s, %s) 는 묻기 전에 404', async (post, attachment) => {
      await expect(
        publicNotices.attachmentDownloadUrl(post, attachment),
      ).rejects.toThrow(NotFoundException);
      await expect(
        supportNotices.attachmentDownloadUrl(admin, post, attachment),
      ).rejects.toThrow(NotFoundException);
      expect(service.attachmentDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
