import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';
import type { SaveCodeGroupsDto } from './dto/save-code-groups.dto';
import type { SaveCodeItemsDto } from './dto/save-code-items.dto';

describe('CodeGroupsController', () => {
  let controller: CodeGroupsController;
  let codes: Record<
    'listGroups' | 'saveGroups' | 'listItems' | 'saveItems' | 'applyToBps',
    jest.Mock
  >;
  let permissions: { assert: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const items = { updates: [], creates: [] };

  beforeEach(async () => {
    codes = {
      listGroups: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      saveGroups: jest.fn().mockResolvedValue(undefined),
      listItems: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      saveItems: jest.fn().mockResolvedValue(undefined),
      applyToBps: jest
        .fn()
        .mockResolvedValue({ bpCount: 0, itemCount: 0, createdCount: 0 }),
    };
    permissions = { assert: jest.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      controllers: [CodeGroupsController],
      providers: [
        { provide: CodeGroupsService, useValue: codes },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
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

  // 메뉴 MN000216(플랫폼 공통코드 관리). 조회는 read, 패널 저장 · BP 적용은 update — 플랫폼 관리자 전용.
  it.each([
    ['listGroups', 'read'],
    ['listItems', 'read'],
    ['applyToBps', 'update'],
    ['saveGroups', 'update'],
    ['saveItems', 'update'],
  ] as const)(
    '%s 는 MN000216 %s 권한 · 플랫폼 관리자 전용으로 표시돼 있다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(
            CodeGroupsController.prototype,
            method,
          )!.value as object,
        ),
      ).toEqual({
        menuCode: 'MN000216',
        action,
        platformOnly: true,
      });
    },
  );

  // 수정 권한은 가드가 봤다. 본문에 새 항목이 섞일 때만 등록 권한을 경로 안에서 더 본다.
  describe.each([
    {
      label: '그룹 저장',
      name: 'saveGroups' as const,
      save: (body: SaveCodeGroupsDto) => controller.saveGroups(admin, body),
      updatesOnly: { updates: [groupUpdate], creates: [] },
      withCreates: { updates: [groupUpdate], creates: [groupRow] },
    },
    {
      label: '상세 코드 저장',
      name: 'saveItems' as const,
      save: (body: SaveCodeItemsDto) =>
        controller.saveItems(admin, 'EMP_TYPE', body),
      updatesOnly: { updates: [itemRow], creates: [] },
      withCreates: { updates: [], creates: [itemRow] },
    },
  ] as {
    label: string;
    name: 'saveGroups' | 'saveItems';
    save: (body: never) => Promise<void>;
    updatesOnly: never;
    withCreates: never;
  }[])('$label', ({ name, save, updatesOnly, withCreates }) => {
    it('새 항목이 없으면 등록 권한을 보지 않는다', async () => {
      await save(updatesOnly);

      expect(permissions.assert).not.toHaveBeenCalled();
      expect(codes[name]).toHaveBeenCalledTimes(1);
    });

    it('새 항목이 섞이면 MN000216 create 권한을 더 본다', async () => {
      await save(withCreates);

      expect(permissions.assert).toHaveBeenCalledTimes(1);
      expect(permissions.assert).toHaveBeenCalledWith(9, 'MN000216', 'create');
      expect(codes[name]).toHaveBeenCalledTimes(1);
    });

    it('등록 권한이 없으면 저장하지 않고 403', async () => {
      permissions.assert.mockRejectedValue(new ForbiddenException());

      await expect(save(withCreates)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(codes[name]).not.toHaveBeenCalled();
    });
  });

  it('저장한 관리자와 그룹 코드를 서비스에 넘긴다', async () => {
    await controller.saveItems(admin, 'EMP_TYPE', items);

    expect(codes.saveItems).toHaveBeenCalledWith(9, 'EMP_TYPE', items);
  });

  // 본문의 코드와 같은 정책 — 소문자 · 앞뒤 공백은 고쳐 받는다.
  it.each(['emp_type', ' EMP_TYPE '])(
    '경로의 그룹 코드 %p 는 EMP_TYPE 으로 받는다',
    async (groupCode) => {
      await controller.listItems(groupCode);
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
      await expect(controller.listItems(groupCode)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(codes.listItems).not.toHaveBeenCalled();
    },
  );

  // 경로마다 가드가 같은 표시를 붙이지만, 가드를 빠뜨린 경로가 더해져도 직원 앱 토큰에 열리지 않게 클래스에도 둔다.
  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, CodeGroupsController)).toEqual([
      'admin',
    ]);
  });
});
