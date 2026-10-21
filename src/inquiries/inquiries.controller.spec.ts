import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';

describe('InquiriesController', () => {
  let controller: InquiriesController;
  let inquiries: Record<
    | 'list'
    | 'get'
    | 'startProcessing'
    | 'reply'
    | 'saveInternalMemo'
    | 'attachmentDownloadUrl',
    jest.Mock
  >;
  const user: AuthUser = { type: 'admin', id: 3, loginId: 'admin', sid: 1 };
  const memo = { internalMemo: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };
  const reply = { body: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };

  beforeEach(async () => {
    inquiries = {
      list: jest.fn(),
      get: jest.fn(),
      startProcessing: jest.fn(),
      reply: jest.fn(),
      saveInternalMemo: jest.fn(),
      attachmentDownloadUrl: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [InquiriesController],
      providers: [{ provide: InquiriesService, useValue: inquiries }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(InquiriesController);
  });

  it.each([
    ['list', 'read'],
    ['get', 'read'],
    ['attachmentDownloadUrl', 'read'],
    ['startProcessing', 'update'],
    ['reply', 'update'],
    ['saveInternalMemo', 'update'],
  ] as const)(
    '%s 는 메뉴 MN000221 의 %s 권한 + 플랫폼 계정',
    (name, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(InquiriesController.prototype, name)!
            .value as object,
        ),
      ).toEqual({ action, platformOnly: true });
    },
  );

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.startProcessing(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(inquiries.startProcessing).not.toHaveBeenCalled();
    },
  );

  it('로그인한 관리자와 그 ID 로 넘긴다', async () => {
    await controller.startProcessing(user, '2147483647');
    await controller.reply(user, '7', reply);
    await controller.saveInternalMemo(user, '7', memo);
    expect(inquiries.startProcessing).toHaveBeenCalledWith(3, 2147483647);
    expect(inquiries.reply).toHaveBeenCalledWith(3, 7, reply);
    expect(inquiries.saveInternalMemo).toHaveBeenCalledWith(7, memo);
  });

  it('목록 조건과 상세 ID 를 그대로 넘긴다', async () => {
    const query = { answerStatus: 'WAITING' as const, page: 2, pageSize: 10 };
    await controller.list(user, query);
    await controller.get(user, '7');
    expect(inquiries.list).toHaveBeenCalledWith(query);
    expect(inquiries.get).toHaveBeenCalledWith(7);
  });

  it('상세의 경로 ID 가 범위 밖이면 404', async () => {
    await expect(controller.get(user, '2147483648')).rejects.toThrow(
      NotFoundException,
    );
    expect(inquiries.get).not.toHaveBeenCalled();
  });

  it('첨부 내려받기는 문의 ID 와 첨부 ID 를 넘긴다', async () => {
    await controller.attachmentDownloadUrl(user, '7', '3');
    expect(inquiries.attachmentDownloadUrl).toHaveBeenCalledWith(7, 3);
  });

  it.each([
    ['7', '0'],
    ['7', '2147483648'],
    ['0', '3'],
  ])(
    '첨부 경로 ID (%s, %s) 가 범위 밖이면 404',
    async (rawId, rawAttachmentId) => {
      await expect(
        controller.attachmentDownloadUrl(user, rawId, rawAttachmentId),
      ).rejects.toThrow(NotFoundException);
      expect(inquiries.attachmentDownloadUrl).not.toHaveBeenCalled();
    },
  );
});
