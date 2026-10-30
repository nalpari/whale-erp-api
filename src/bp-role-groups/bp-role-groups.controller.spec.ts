import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { BpRoleGroupMenusService } from './bp-role-group-menus.service';
import { BpRoleGroupsController } from './bp-role-groups.controller';
import { BpRoleGroupsService } from './bp-role-groups.service';

describe('BpRoleGroupsController', () => {
  let controller: BpRoleGroupsController;
  let groups: Record<
    | 'scopeOf'
    | 'list'
    | 'detail'
    | 'create'
    | 'update'
    | 'deletionCandidates'
    | 'remove',
    jest.Mock
  >;
  let menus: Record<
    'tree' | 'save' | 'preview' | 'franchiseMasterTree',
    jest.Mock
  >;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const scope = {
    caller: { adminAccountId: 9, roleTypeCode: 'BM', roleGroupId: 2 },
    bpCodeId: 7,
    managerId: null,
    writableType: 'BA',
  };
  const UPDATED_AT = '2026-10-15T01:00:00.000Z';
  const menuBody = { menus: [], updatedAt: UPDATED_AT };

  beforeEach(async () => {
    groups = {
      scopeOf: jest.fn().mockResolvedValue(scope),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      detail: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(undefined),
      deletionCandidates: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    menus = {
      tree: jest.fn().mockResolvedValue({}),
      save: jest.fn().mockResolvedValue({}),
      preview: jest.fn().mockResolvedValue({}),
      franchiseMasterTree: jest.fn().mockResolvedValue({}),
    };
    const module = await Test.createTestingModule({
      controllers: [BpRoleGroupsController],
      providers: [
        { provide: BpRoleGroupsService, useValue: groups },
        { provide: BpRoleGroupMenusService, useValue: menus },
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(BpRoleGroupsController);
  });

  const bp = { bpCodeId: 7, isPlatformCaller: false };
  const calls = [
    [
      'list',
      'read',
      () => controller.list(user, bp, { page: 1, pageSize: 20 }),
    ],
    ['detail', 'read', () => controller.detail(user, '5', bp)],
    ['create', 'create', () => controller.create(user, bp, { name: 'a' })],
    [
      'update',
      'update',
      () =>
        controller.update(user, '5', bp, { name: 'a', updatedAt: UPDATED_AT }),
    ],
    ['menus', 'read', () => controller.menus(user, '5', bp)],
    [
      'saveMenus',
      'update',
      () => controller.saveMenus(user, '5', bp, menuBody),
    ],
    [
      'previewMenus',
      'read',
      () => controller.previewMenus(user, '5', bp, { menus: [] }),
    ],
    [
      'deletionCandidates',
      'read',
      () => controller.deletionCandidates(user, '5', bp),
    ],
    [
      'remove',
      'delete',
      () => controller.remove(user, '5', bp, { updatedAt: UPDATED_AT }),
    ],
    [
      'franchiseMasterMenus',
      'read',
      () => controller.franchiseMasterMenus(user, bp),
    ],
  ] as const;

  it.each(calls)(
    '%s 는 가드로 경로 메뉴(/bp-role-groups) %s 권한을 본다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(
            BpRoleGroupsController.prototype,
            method,
          )!.value as object,
        ),
      ).toEqual({ action });
    },
  );

  it.each(calls)(
    '%s 는 호출자 id 와 가드가 정한 대상 BP 로 범위를 정한다',
    async (_method, _action, call) => {
      await call();
      expect(groups.scopeOf).toHaveBeenCalledWith(9, bp);
    },
  );

  it.each(['0', 'abc', '2147483648'])(
    'id %p 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.detail(user, raw, bp)).rejects.toThrow(
        NotFoundException,
      );
      expect(groups.scopeOf).not.toHaveBeenCalled();
    },
  );

  it('서비스에 범위와 id · 본문을 넘긴다', async () => {
    await controller.remove(user, '5', bp, { updatedAt: UPDATED_AT });
    expect(groups.remove).toHaveBeenCalledWith(scope, 5, {
      updatedAt: UPDATED_AT,
    });
    await controller.list(user, bp, { page: 2, pageSize: 50 });
    expect(groups.list).toHaveBeenCalledWith(scope, { page: 2, pageSize: 50 });
  });
});
