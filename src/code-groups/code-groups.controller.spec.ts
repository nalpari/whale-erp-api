import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';

describe('CodeGroupsController', () => {
  let controller: CodeGroupsController;
  let codes: Record<
    | 'assertPlatformAdmin'
    | 'listGroups'
    | 'saveGroups'
    | 'listItems'
    | 'saveItems'
    | 'applyToBps',
    jest.Mock
  >;
  const admin: AuthUser = { id: 9, type: 'admin', email: 'a@test.invalid' };
  const items = { updates: [], creates: [] };

  beforeEach(async () => {
    codes = {
      assertPlatformAdmin: jest.fn().mockResolvedValue(undefined),
      listGroups: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      saveGroups: jest.fn().mockResolvedValue(undefined),
      listItems: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      saveItems: jest.fn().mockResolvedValue(undefined),
      applyToBps: jest
        .fn()
        .mockResolvedValue({ bpCount: 0, itemCount: 0, createdCount: 0 }),
    };
    const module = await Test.createTestingModule({
      controllers: [CodeGroupsController],
      providers: [{ provide: CodeGroupsService, useValue: codes }],
    }).compile();
    controller = module.get(CodeGroupsController);
  });

  it('모든 동작이 플랫폼 관리자인지 먼저 확인한다', async () => {
    await controller.listGroups(admin, { page: 1, pageSize: 20 });
    await controller.saveGroups(admin, { updates: [], creates: [] });
    await controller.listItems(admin, 'EMP_TYPE');
    await controller.saveItems(admin, 'EMP_TYPE', items);
    await controller.applyToBps(admin, 'EMP_TYPE');

    expect(codes.assertPlatformAdmin).toHaveBeenCalledTimes(5);
    expect(codes.assertPlatformAdmin).toHaveBeenCalledWith(9);
  });

  it.each([
    [
      'listGroups',
      () => controller.listGroups(admin, { page: 1, pageSize: 20 }),
    ],
    ['saveGroups', () => controller.saveGroups(admin, items)],
    ['listItems', () => controller.listItems(admin, 'EMP_TYPE')],
    ['saveItems', () => controller.saveItems(admin, 'EMP_TYPE', items)],
    ['applyToBps', () => controller.applyToBps(admin, 'EMP_TYPE')],
  ] as const)(
    '플랫폼 관리자가 아니면 %s 는 서비스를 부르지 않고 403',
    async (name, call) => {
      codes.assertPlatformAdmin.mockRejectedValue(new ForbiddenException());

      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      expect(codes[name]).not.toHaveBeenCalled();
    },
  );

  it('저장한 관리자와 그룹 코드를 서비스에 넘긴다', async () => {
    await controller.saveItems(admin, 'EMP_TYPE', items);

    expect(codes.saveItems).toHaveBeenCalledWith(9, 'EMP_TYPE', items);
  });

  // 본문의 코드와 같은 정책 — 소문자 · 앞뒤 공백은 고쳐 받는다.
  it.each(['emp_type', ' EMP_TYPE '])(
    '경로의 그룹 코드 %p 는 EMP_TYPE 으로 받는다',
    async (groupCode) => {
      await controller.listItems(admin, groupCode);
      await controller.saveItems(admin, groupCode, items);
      await controller.applyToBps(admin, groupCode);

      expect(codes.listItems).toHaveBeenCalledWith('EMP_TYPE');
      expect(codes.saveItems).toHaveBeenCalledWith(9, 'EMP_TYPE', items);
      expect(codes.applyToBps).toHaveBeenCalledWith(9, 'EMP_TYPE');
    },
  );

  it.each(['1ABC', 'A'.repeat(21), 'EMP-TYPE', '가나'])(
    '경로의 그룹 코드 형식이 틀리면(%p) DB 에 묻기 전에 404',
    async (groupCode) => {
      await expect(
        controller.listItems(admin, groupCode),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(codes.listItems).not.toHaveBeenCalled();
    },
  );
});
