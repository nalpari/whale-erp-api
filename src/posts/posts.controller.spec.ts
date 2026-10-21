import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import {
  PlatformFaqsController,
  PlatformNoticesController,
} from './posts.controller';
import { PostsService } from './posts.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.4');

const permissionOf = (cls: { prototype: object }, name: string) =>
  Reflect.getMetadata(
    MENU_PERMISSION,
    Object.getOwnPropertyDescriptor(cls.prototype, name)!.value as object,
  ) as unknown;

describe('PlatformNoticesController · PlatformFaqsController', () => {
  let notices: PlatformNoticesController;
  let faqs: PlatformFaqsController;
  let posts: Record<
    'list' | 'get' | 'create' | 'update' | 'remove' | 'attachmentDownloadUrl',
    jest.Mock
  >;
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
    const module = await Test.createTestingModule({
      controllers: [PlatformNoticesController, PlatformFaqsController],
      providers: [{ provide: PostsService, useValue: posts }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    notices = module.get(PlatformNoticesController);
    faqs = module.get(PlatformFaqsController);
  });

  it.each([
    ['list', 'read'],
    ['get', 'read'],
    ['create', 'create'],
    ['update', 'update'],
    ['remove', 'delete'],
    ['attachmentDownloadUrl', 'read'],
  ])('공지사항 %s 는 MN000219 의 %s 권한 + 플랫폼 계정', (name, action) => {
    expect(permissionOf(PlatformNoticesController, name)).toEqual({
      action,
      platformOnly: true,
    });
  });

  it.each([
    ['list', 'read'],
    ['get', 'read'],
    ['create', 'create'],
    ['update', 'update'],
    ['remove', 'delete'],
  ])('FAQ %s 는 MN000220 의 %s 권한 + 플랫폼 계정', (name, action) => {
    expect(permissionOf(PlatformFaqsController, name)).toEqual({
      action,
      platformOnly: true,
    });
  });

  it('FAQ 는 글 종류 FAQ 로 넘기고 첨부를 받지 않는다', async () => {
    await faqs.list({});
    expect(posts.list).toHaveBeenCalledWith('FAQ', {});
    await faqs.get('7');
    expect(posts.get).toHaveBeenCalledWith('FAQ', 7);
    await faqs.create(user, {} as never);
    expect(posts.create).toHaveBeenCalledWith(3, 'FAQ', {});
    await faqs.update(user, '7', {} as never);
    expect(posts.update).toHaveBeenCalledWith(3, 'FAQ', 7, {});
    await faqs.remove(user, '7');
    expect(posts.remove).toHaveBeenCalledWith(3, 'FAQ', 7);
    expect(
      Object.getOwnPropertyNames(PlatformFaqsController.prototype),
    ).not.toContain('attachmentDownloadUrl');
  });

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      expect(() => notices.get(raw)).toThrow(NotFoundException);
      await expect(notices.remove(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(() => faqs.get(raw)).toThrow(NotFoundException);
      expect(posts.get).not.toHaveBeenCalled();
      expect(posts.remove).not.toHaveBeenCalled();
    },
  );

  it('정수 범위 안이면 글 종류와 그 ID 로 넘긴다', async () => {
    await notices.get('2147483647');
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
    ])('%s 는 400 이고 저장하지 않는다', (_, file) => {
      expect(() => notices.create(user, {} as never, [file])).toThrow(
        BadRequestException,
      );
      expect(() => notices.update(user, '7', {} as never, [file])).toThrow(
        BadRequestException,
      );
      expect(posts.create).not.toHaveBeenCalled();
      expect(posts.update).not.toHaveBeenCalled();
    });

    it.each(['0', '2147483648', 'abc'])(
      '첨부 ID %s 는 묻기 전에 404',
      (raw) => {
        expect(() => notices.attachmentDownloadUrl('7', raw)).toThrow(
          NotFoundException,
        );
        expect(posts.attachmentDownloadUrl).not.toHaveBeenCalled();
      },
    );

    it('내려받기 주소는 글 종류 · 글 ID · 첨부 ID 로 묻는다', async () => {
      await notices.attachmentDownloadUrl('7', '3');
      expect(posts.attachmentDownloadUrl).toHaveBeenCalledWith('NOTICE', 7, 3);
    });
  });
});
