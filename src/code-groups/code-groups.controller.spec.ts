import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';

describe('CodeGroupsController', () => {
  let controller: CodeGroupsController;
  let codes: Record<
    | 'assertAllowed'
    | 'listGroups'
    | 'saveGroups'
    | 'listItems'
    | 'saveItems'
    | 'applyToBps',
    jest.Mock
  >;
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const items = { updates: [], creates: [] };

  beforeEach(async () => {
    codes = {
      assertAllowed: jest.fn().mockResolvedValue(undefined),
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

  const groupRow = {
    groupCode: 'EMP_TYPE',
    groupName: '고용 형태',
    manageOwnerCode: 'PLATFORM_PROVIDED' as const,
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };
  const groupUpdate = {
    groupCode: 'EMP_TYPE',
    groupName: '고용 형태',
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };
  const itemRow = {
    itemCode: 'FULL',
    label: '정직원',
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };

  // 메뉴 MN000216(플랫폼 공통코드 관리). 조회는 read, 패널 저장 · BP 적용은 update, 저장에 새 항목이 섞이면 create 도.
  it.each([
    [
      '그룹 목록',
      () => controller.listGroups(admin, { page: 1, pageSize: 20 }),
      ['read'],
    ],
    ['상세 코드 목록', () => controller.listItems(admin, 'EMP_TYPE'), ['read']],
    [
      '수정만 있는 그룹 저장',
      () =>
        controller.saveGroups(admin, { updates: [groupUpdate], creates: [] }),
      ['update'],
    ],
    [
      '새 그룹이 섞인 그룹 저장',
      () =>
        controller.saveGroups(admin, {
          updates: [groupUpdate],
          creates: [groupRow],
        }),
      ['update', 'create'],
    ],
    [
      '새 그룹만 있는 그룹 저장',
      () => controller.saveGroups(admin, { updates: [], creates: [groupRow] }),
      ['update', 'create'],
    ],
    [
      '수정만 있는 상세 코드 저장',
      () =>
        controller.saveItems(admin, 'EMP_TYPE', {
          updates: [itemRow],
          creates: [],
        }),
      ['update'],
    ],
    [
      '새 코드가 섞인 상세 코드 저장',
      () =>
        controller.saveItems(admin, 'EMP_TYPE', {
          updates: [],
          creates: [itemRow],
        }),
      ['update', 'create'],
    ],
    ['BP 적용', () => controller.applyToBps(admin, 'EMP_TYPE'), ['update']],
  ] as const)('%s 는 메뉴 권한 %j 를 요구한다', async (_, call, actions) => {
    await call();

    expect(codes.assertAllowed).toHaveBeenCalledTimes(1);
    expect(codes.assertAllowed).toHaveBeenCalledWith(9, actions);
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
    '권한이 없으면 %s 는 서비스를 부르지 않고 403',
    async (name, call) => {
      codes.assertAllowed.mockRejectedValue(new ForbiddenException());

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
