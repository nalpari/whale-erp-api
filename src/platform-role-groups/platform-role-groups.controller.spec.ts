import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { PlatformRoleGroupMenusService } from './platform-role-group-menus.service';
import { PlatformRoleGroupsController } from './platform-role-groups.controller';
import { PlatformRoleGroupsService } from './platform-role-groups.service';

describe('PlatformRoleGroupsController', () => {
  let controller: PlatformRoleGroupsController;
  let permissions: { assert: jest.Mock };
  let scope: { isPlatformAdmin: jest.Mock };
  let groups: Record<
    'list' | 'detail' | 'create' | 'update' | 'deletionCandidates' | 'remove',
    jest.Mock
  >;
  let menus: Record<'tree' | 'save' | 'preview', jest.Mock>;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const caller = { adminAccountId: 9, roleTypeCode: 'PA', roleGroupId: 2 };
  const UPDATED_AT = '2026-10-15T01:00:00.000Z';
  const menuBody = { menus: [], updatedAt: UPDATED_AT };

  beforeEach(async () => {
    permissions = { assert: jest.fn().mockResolvedValue(caller) };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    groups = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      detail: jest.fn().mockResolvedValue({}),
      create: jest
        .fn()
        .mockResolvedValue({ roleGroupId: 5, roleCode: 'PA000002' }),
      update: jest.fn().mockResolvedValue(undefined),
      deletionCandidates: jest
        .fn()
        .mockResolvedValue({ admins: [], candidates: [] }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    menus = {
      tree: jest.fn().mockResolvedValue({ services: [] }),
      save: jest.fn().mockResolvedValue({ updatedAt: new Date() }),
      preview: jest.fn().mockResolvedValue({}),
    };
    const module = await Test.createTestingModule({
      controllers: [PlatformRoleGroupsController],
      providers: [
        { provide: PlatformRoleGroupsService, useValue: groups },
        { provide: PlatformRoleGroupMenusService, useValue: menus },
        { provide: MenuPermissionsService, useValue: permissions },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PlatformRoleGroupsController);
  });

  const calls = [
    ['list', 'read', () => controller.list(user)],
    ['detail', 'read', () => controller.detail(user, '5')],
    ['create', 'create', () => controller.create(user, { name: 'a' })],
    [
      'update',
      'update',
      () => controller.update(user, '5', { name: 'a', updatedAt: UPDATED_AT }),
    ],
    ['menus', 'read', () => controller.menus(user, '5')],
    ['saveMenus', 'update', () => controller.saveMenus(user, '5', menuBody)],
    [
      'previewMenus',
      'read',
      () => controller.previewMenus(user, '5', { menus: [] }),
    ],
    [
      'deletionCandidates',
      'read',
      () => controller.deletionCandidates(user, '5'),
    ],
    [
      'remove',
      'delete',
      () => controller.remove(user, '5', { updatedAt: UPDATED_AT }),
    ],
  ] as const;

  it.each(calls)('%s 는 MN000214 %s 권한을 본다', async (_, action, call) => {
    await call();
    expect(permissions.assert).toHaveBeenCalledWith(9, 'MN000214', action);
    expect(scope.isPlatformAdmin).toHaveBeenCalledWith(9);
  });

  it.each(calls)(
    '%s — 플랫폼 BP 의 사용 중 PM · PA 가 아니면 공용 문구로 403, 업무 서비스를 부르지 않는다',
    async (_, __, call) => {
      scope.isPlatformAdmin.mockResolvedValue(false);
      await expect(call()).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      for (const fn of [...Object.values(groups), ...Object.values(menus)])
        expect(fn).not.toHaveBeenCalled();
    },
  );

  it('메뉴 권한이 없으면 assert 의 403 을 그대로 낸다', async () => {
    permissions.assert.mockRejectedValue(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
    await expect(controller.list(user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(scope.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it('호출자와 id 를 서비스에 넘긴다', async () => {
    await controller.saveMenus(user, '5', menuBody);
    expect(menus.save).toHaveBeenCalledWith(caller, 5, menuBody);
    await controller.remove(user, '7', {
      replacementRoleGroupId: 6,
      updatedAt: UPDATED_AT,
    });
    expect(groups.remove).toHaveBeenCalledWith(caller, 7, {
      replacementRoleGroupId: 6,
      updatedAt: UPDATED_AT,
    });
  });

  it.each(['0', '-1', 'abc', '2147483648', '1.5'])(
    'id %p 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.detail(user, raw)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(permissions.assert).not.toHaveBeenCalled();
    },
  );

  const BIG = '2147483648';
  it.each([
    [
      'update',
      () => controller.update(user, BIG, { name: 'a', updatedAt: UPDATED_AT }),
    ],
    ['menus', () => controller.menus(user, BIG)],
    ['saveMenus', () => controller.saveMenus(user, BIG, menuBody)],
    ['previewMenus', () => controller.previewMenus(user, BIG, { menus: [] })],
    ['deletionCandidates', () => controller.deletionCandidates(user, BIG)],
    ['remove', () => controller.remove(user, BIG, { updatedAt: UPDATED_AT })],
  ] as const)('%s 도 범위 밖 id 는 DB 에 묻지 않고 404', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    for (const fn of [...Object.values(groups), ...Object.values(menus)])
      expect(fn).not.toHaveBeenCalled();
  });
});
