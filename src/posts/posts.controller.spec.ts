import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import {
  PlatformFaqsController,
  PlatformNoticesController,
} from './posts.controller';
import { PostsService } from './posts.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.4');

describe('PlatformNoticesController · PlatformFaqsController', () => {
  let notices: PlatformNoticesController;
  let faqs: PlatformFaqsController;
  let posts: Record<
    'list' | 'get' | 'create' | 'update' | 'remove' | 'attachmentDownloadUrl',
    jest.Mock
  >;
  let scope: { isPlatformAdmin: jest.Mock };
  let permissions: { assert: jest.Mock };
  const user: AuthUser = { type: 'admin', id: 3, loginId: 'admin', sid: 1 };
  const upload = (originalname: string, buffer: Buffer) => ({
    originalname,
    buffer,
    size: buffer.length,
  });

  beforeEach(async () => {
    posts = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      attachmentDownloadUrl: jest.fn(),
    };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    permissions = { assert: jest.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      controllers: [PlatformNoticesController, PlatformFaqsController],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: AdminScopeService, useValue: scope },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
    }).compile();
    notices = module.get(PlatformNoticesController);
    faqs = module.get(PlatformFaqsController);
  });

  const calls = () =>
    [
      ['list', 'read', () => notices.list(user, {})],
      ['get', 'read', () => notices.get(user, '7')],
      ['create', 'create', () => notices.create(user, {} as never, undefined)],
      [
        'update',
        'update',
        () => notices.update(user, '7', {} as never, undefined),
      ],
      ['remove', 'delete', () => notices.remove(user, '7')],
      [
        'attachmentDownloadUrl',
        'read',
        () => notices.attachmentDownloadUrl(user, '7', '3'),
      ],
    ] as const;

  it('동작마다 공지사항 메뉴(MN000219)의 그 권한을 본다', async () => {
    for (const [, action, run] of calls()) {
      permissions.assert.mockClear();
      await run();
      expect(permissions.assert).toHaveBeenCalledWith(3, 'MN000219', action);
    }
  });

  it('FAQ 는 FAQ 메뉴(MN000220)의 권한을 보고 글 종류 FAQ 로 넘긴다', async () => {
    await faqs.list(user, {});
    expect(permissions.assert).toHaveBeenCalledWith(3, 'MN000220', 'read');
    expect(posts.list).toHaveBeenCalledWith('FAQ', {});
    await faqs.create(user, {} as never);
    expect(permissions.assert).toHaveBeenCalledWith(3, 'MN000220', 'create');
    expect(posts.create).toHaveBeenCalledWith(3, 'FAQ', {});
    await faqs.update(user, '7', {} as never);
    expect(posts.update).toHaveBeenCalledWith(3, 'FAQ', 7, {});
    await faqs.remove(user, '7');
    expect(permissions.assert).toHaveBeenCalledWith(3, 'MN000220', 'delete');
    expect(posts.remove).toHaveBeenCalledWith(3, 'FAQ', 7);
  });

  it('메뉴 권한이 없으면 403 이고 묻지 않는다', async () => {
    permissions.assert.mockRejectedValue(new ForbiddenException());
    for (const [name, , run] of calls()) {
      await expect(run()).rejects.toThrow(ForbiddenException);
      expect(posts[name]).not.toHaveBeenCalled();
    }
  });

  it('메뉴 권한이 있어도 플랫폼 관리자가 아니면 403', async () => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    for (const [name, , run] of calls()) {
      await expect(run()).rejects.toThrow(ForbiddenException);
      expect(posts[name]).not.toHaveBeenCalled();
    }
  });

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(notices.get(user, raw)).rejects.toThrow(NotFoundException);
      await expect(notices.remove(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(posts.get).not.toHaveBeenCalled();
      expect(posts.remove).not.toHaveBeenCalled();
    },
  );

  it('정수 범위 안이면 글 종류와 그 ID 로 넘긴다', async () => {
    await notices.get(user, '2147483647');
    expect(posts.get).toHaveBeenCalledWith('NOTICE', 2147483647);
  });

  describe('첨부파일 (WHALEERP-272)', () => {
    it('등록 · 수정은 첨부를 내용으로 검사해 넘긴다', async () => {
      const files = [upload('사진.png', PNG), upload('안내.pdf', PDF)];
      const checked = [
        { fileName: '사진.png', buffer: PNG, fileType: 'PNG', sizeBytes: 9 },
        { fileName: '안내.pdf', buffer: PDF, fileType: 'PDF', sizeBytes: 8 },
      ];
      await notices.create(user, {} as never, files);
      expect(posts.create).toHaveBeenCalledWith(3, 'NOTICE', {}, checked);
      await notices.update(user, '7', {} as never, files);
      expect(posts.update).toHaveBeenCalledWith(3, 'NOTICE', 7, {}, checked);
    });

    it('첨부가 없으면 빈 목록', async () => {
      await notices.create(user, {} as never, undefined);
      expect(posts.create).toHaveBeenCalledWith(3, 'NOTICE', {}, []);
    });

    it.each([
      ['NUL 문자가 든 파일 이름', upload('a\u0000.png', PNG)],
      [
        'JPG · PNG · PDF 가 아닌 내용(이름은 .png)',
        upload('x.png', Buffer.from('GIF89a')),
      ],
    ])('%s 는 400 이고 저장하지 않는다', async (_, file) => {
      await expect(
        notices.create(user, {} as never, [file]),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        notices.update(user, '7', {} as never, [file]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(posts.create).not.toHaveBeenCalled();
      expect(posts.update).not.toHaveBeenCalled();
    });

    it.each(['0', '2147483648', 'abc'])(
      '첨부 ID %s 는 묻기 전에 404',
      async (raw) => {
        await expect(
          notices.attachmentDownloadUrl(user, '7', raw),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(posts.attachmentDownloadUrl).not.toHaveBeenCalled();
      },
    );

    it('내려받기 주소는 글 ID · 첨부 ID 로 묻는다', async () => {
      await notices.attachmentDownloadUrl(user, '7', '3');
      expect(posts.attachmentDownloadUrl).toHaveBeenCalledWith(7, 3);
    });
  });
});
