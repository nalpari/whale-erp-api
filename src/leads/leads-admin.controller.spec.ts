import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { LeadsAdminController } from './leads-admin.controller';
import { LeadsAdminService } from './leads-admin.service';

describe('LeadsAdminController', () => {
  let controller: LeadsAdminController;
  let leads: Record<
    | 'list'
    | 'get'
    | 'startProcessing'
    | 'reply'
    | 'saveInternalMemo'
    | 'remove'
    | 'resendReplyMail',
    jest.Mock
  >;
  const user: AuthUser = { type: 'admin', id: 3, loginId: 'admin', sid: 1 };
  const memo = { internalMemo: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };
  const reply = { reply: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };

  beforeEach(async () => {
    leads = {
      list: jest.fn(),
      get: jest.fn(),
      startProcessing: jest.fn(),
      reply: jest.fn(),
      saveInternalMemo: jest.fn(),
      remove: jest.fn(),
      resendReplyMail: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [LeadsAdminController],
      providers: [{ provide: LeadsAdminService, useValue: leads }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(LeadsAdminController);
  });

  it.each([
    ['list', 'read'],
    ['get', 'read'],
    ['startProcessing', 'update'],
    ['reply', 'update'],
    ['resendReplyMail', 'update'],
    ['saveInternalMemo', 'update'],
    ['remove', 'delete'],
  ] as const)(
    '%s 는 메뉴 MN000222 의 %s 권한 + 플랫폼 계정',
    (name, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(LeadsAdminController.prototype, name)!
            .value as object,
        ),
      ).toEqual({ action, platformOnly: true });
    },
  );

  // 접수 컨트롤러(/leads)는 @Public 이다. 관리자 경로가 그것을 물려받으면 누구나 답변을 쓴다.
  it('공개 경로가 아니다', () => {
    expect(
      new Reflector().get(IS_PUBLIC, LeadsAdminController),
    ).toBeUndefined();
  });

  it.each(['0', '2147483648', 'abc'])('경로 ID %s 는 404', async (raw) => {
    await expect(controller.reply(user, raw, reply)).rejects.toThrow(
      NotFoundException,
    );
    expect(leads.reply).not.toHaveBeenCalled();
  });

  it('로그인한 관리자와 그 ID 로 넘긴다', async () => {
    await controller.startProcessing(user, '5');
    await controller.reply(user, '5', reply);
    await controller.saveInternalMemo(user, '5', memo);
    await controller.remove(user, '5');
    await controller.resendReplyMail(user, '5');
    expect(leads.remove).toHaveBeenCalledWith(3, 5);
    expect(leads.resendReplyMail).toHaveBeenCalledWith(3, 5);
    expect(leads.startProcessing).toHaveBeenCalledWith(3, 5);
    expect(leads.reply).toHaveBeenCalledWith(3, 5, reply);
    expect(leads.saveInternalMemo).toHaveBeenCalledWith(5, memo);
  });

  it('목록 조건과 상세 ID 를 그대로 넘긴다', async () => {
    const query = { answerStatus: 'ANSWERED' as const, page: 1, pageSize: 20 };
    await controller.list(user, query);
    await controller.get(user, '5');
    expect(leads.list).toHaveBeenCalledWith(query);
    expect(leads.get).toHaveBeenCalledWith(5);
  });

  it('상세의 경로 ID 가 범위 밖이면 404', async () => {
    await expect(controller.get(user, '0')).rejects.toThrow(NotFoundException);
    expect(leads.get).not.toHaveBeenCalled();
  });
});
