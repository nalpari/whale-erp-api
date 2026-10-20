import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { AuthUser } from '../auth/auth.types';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.4');

describe('PostsController', () => {
  let controller: PostsController;
  let posts: Record<
    'list' | 'get' | 'create' | 'update' | 'remove' | 'attachmentDownloadUrl',
    jest.Mock
  >;
  let scope: { isPlatformAdmin: jest.Mock };
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
    const module = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PostsController);
  });

  it.each([
    ['list', () => controller.list(user, { contentType: 'NOTICE' })],
    ['get', () => controller.get(user, '7')],
    ['create', () => controller.create(user, {} as never, undefined)],
    ['update', () => controller.update(user, '7', {} as never, undefined)],
    ['remove', () => controller.remove(user, '7')],
    [
      'attachmentDownloadUrl',
      () => controller.attachmentDownloadUrl(user, '7', '3'),
    ],
  ] as const)('플랫폼 관리자가 아니면 %s 는 403', async (name, run) => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    await expect(run()).rejects.toThrow(ForbiddenException);
    expect(posts[name]).not.toHaveBeenCalled();
  });

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.get(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      await expect(controller.remove(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(posts.get).not.toHaveBeenCalled();
      expect(posts.remove).not.toHaveBeenCalled();
    },
  );

  it('정수 범위 안이면 그 ID 로 넘긴다', async () => {
    await controller.get(user, '2147483647');
    expect(posts.get).toHaveBeenCalledWith(2147483647);
  });

  describe('첨부파일 (WHALEERP-272)', () => {
    it('등록 · 수정은 첨부를 내용으로 검사해 넘긴다', async () => {
      const files = [upload('사진.png', PNG), upload('안내.pdf', PDF)];
      const checked = [
        { fileName: '사진.png', buffer: PNG, fileType: 'PNG', sizeBytes: 9 },
        { fileName: '안내.pdf', buffer: PDF, fileType: 'PDF', sizeBytes: 8 },
      ];
      await controller.create(user, {} as never, files);
      expect(posts.create).toHaveBeenCalledWith(3, {}, checked);
      await controller.update(user, '7', {} as never, files);
      expect(posts.update).toHaveBeenCalledWith(3, 7, {}, checked);
    });

    it('첨부가 없으면 빈 목록', async () => {
      await controller.create(user, {} as never, undefined);
      expect(posts.create).toHaveBeenCalledWith(3, {}, []);
    });

    it.each([
      ['NUL 문자가 든 파일 이름', upload('a\u0000.png', PNG)],
      [
        'JPG · PNG · PDF 가 아닌 내용(이름은 .png)',
        upload('x.png', Buffer.from('GIF89a')),
      ],
    ])('%s 는 400 이고 저장하지 않는다', async (_, file) => {
      await expect(
        controller.create(user, {} as never, [file]),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.update(user, '7', {} as never, [file]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(posts.create).not.toHaveBeenCalled();
      expect(posts.update).not.toHaveBeenCalled();
    });

    it.each(['0', '2147483648', 'abc'])(
      '첨부 ID %s 는 묻기 전에 404',
      async (raw) => {
        await expect(
          controller.attachmentDownloadUrl(user, '7', raw),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(posts.attachmentDownloadUrl).not.toHaveBeenCalled();
      },
    );

    it('내려받기 주소는 글 ID · 첨부 ID 로 묻는다', async () => {
      await controller.attachmentDownloadUrl(user, '7', '3');
      expect(posts.attachmentDownloadUrl).toHaveBeenCalledWith(7, 3);
    });
  });
});
