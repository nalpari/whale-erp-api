import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import type { AuthUser } from '../auth/auth.types';
import { SupportInquiriesController } from './support-inquiries.controller';
import { SupportInquiriesService } from './support-inquiries.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.4');

describe('SupportInquiriesController', () => {
  let controller: SupportInquiriesController;
  let inquiries: Record<
    'create' | 'list' | 'get' | 'attachmentDownloadUrl',
    jest.Mock
  >;
  const user: AuthUser = { type: 'admin', id: 21, loginId: 'bm', sid: 1 };
  const dto = { inquiryCategoryCode: 'ETC', title: 't', body: 'b' };
  const upload = (originalname: string, buffer: Buffer) => ({
    originalname,
    buffer,
    size: buffer.length,
  });

  beforeEach(async () => {
    inquiries = {
      create: jest.fn().mockResolvedValue({ inquiryId: 7 }),
      list: jest.fn(),
      get: jest.fn(),
      attachmentDownloadUrl: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [SupportInquiriesController],
      providers: [{ provide: SupportInquiriesService, useValue: inquiries }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(SupportInquiriesController);
  });

  it('문의하기(MN000036) — 등록은 등록 권한, 나머지는 조회 권한', () => {
    const permission = (name: keyof SupportInquiriesController) =>
      Reflect.getMetadata(
        MENU_PERMISSION,
        Object.getOwnPropertyDescriptor(
          SupportInquiriesController.prototype,
          name,
        )!.value as object,
      ) as unknown;
    expect(permission('create')).toEqual({
      menuCode: 'MN000036',
      action: 'create',
    });
    for (const name of ['list', 'get', 'attachmentDownloadUrl'] as const)
      expect([name, permission(name)]).toEqual([
        name,
        { menuCode: 'MN000036', action: 'read' },
      ]);
  });

  it('첨부를 내용으로 검사해 넘긴다', async () => {
    await controller.create(user, dto, [
      upload('화면.png', PNG),
      upload('명세.pdf', PDF),
    ]);
    expect(inquiries.create).toHaveBeenCalledWith(21, dto, [
      { fileName: '화면.png', buffer: PNG, fileType: 'PNG', sizeBytes: 9 },
      { fileName: '명세.pdf', buffer: PDF, fileType: 'PDF', sizeBytes: 8 },
    ]);
  });

  it('첨부가 없으면 빈 목록', async () => {
    await controller.create(user, dto, undefined);
    expect(inquiries.create).toHaveBeenCalledWith(21, dto, []);
  });

  it('파일 이름에 NUL 문자가 있으면 400 이고 저장하지 않는다', async () => {
    await expect(
      controller.create(user, dto, [upload('a\u0000.png', PNG)]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inquiries.create).not.toHaveBeenCalled();
  });

  it('JPG · PNG · PDF 가 아닌 파일(GIF)은 이름이 .png 여도 400 이고 저장하지 않는다', async () => {
    await expect(
      controller.create(user, dto, [upload('x.png', Buffer.from('GIF89a'))]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inquiries.create).not.toHaveBeenCalled();
  });

  it.each(['0', '2147483648', 'abc'])(
    '범위 밖 ID %s 는 묻기 전에 404',
    async (raw) => {
      await expect(controller.get(user, raw)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        controller.attachmentDownloadUrl(user, '7', raw),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inquiries.get).not.toHaveBeenCalled();
      expect(inquiries.attachmentDownloadUrl).not.toHaveBeenCalled();
    },
  );

  it('호출한 관리자로 묻는다', async () => {
    await controller.get(user, '7');
    expect(inquiries.get).toHaveBeenCalledWith(21, 7);
    await controller.attachmentDownloadUrl(user, '7', '3');
    expect(inquiries.attachmentDownloadUrl).toHaveBeenCalledWith(21, 7, 3);
  });
});
