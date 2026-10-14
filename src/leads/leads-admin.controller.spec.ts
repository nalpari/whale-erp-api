import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { IS_PUBLIC } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { LeadsAdminController } from './leads-admin.controller';
import { LeadsAdminService } from './leads-admin.service';

describe('LeadsAdminController', () => {
  let controller: LeadsAdminController;
  let leads: Record<
    'list' | 'get' | 'startProcessing' | 'reply' | 'saveInternalMemo',
    jest.Mock
  >;
  let scope: { isPlatformAdmin: jest.Mock };
  const user: AuthUser = { type: 'admin', id: 3, email: 'a@test.invalid' };
  const memo = { internalMemo: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };
  const reply = { reply: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };

  beforeEach(async () => {
    leads = {
      list: jest.fn(),
      get: jest.fn(),
      startProcessing: jest.fn(),
      reply: jest.fn(),
      saveInternalMemo: jest.fn(),
    };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [LeadsAdminController],
      providers: [
        { provide: LeadsAdminService, useValue: leads },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(LeadsAdminController);
  });

  // 접수 컨트롤러(같은 /leads)는 @Public 이다. 관리자 경로가 그것을 물려받으면 누구나 답변을 쓴다.
  it('공개 경로가 아니다', () => {
    expect(
      new Reflector().get(IS_PUBLIC, LeadsAdminController),
    ).toBeUndefined();
  });

  it.each([
    ['list', () => controller.list(user, { page: 1, pageSize: 20 })],
    ['get', () => controller.get(user, '5')],
    ['startProcessing', () => controller.startProcessing(user, '5')],
    ['reply', () => controller.reply(user, '5', reply)],
    ['saveInternalMemo', () => controller.saveInternalMemo(user, '5', memo)],
  ] as const)('플랫폼 관리자가 아니면 %s 는 403', async (name, run) => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    await expect(run()).rejects.toThrow(ForbiddenException);
    expect(leads[name]).not.toHaveBeenCalled();
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
