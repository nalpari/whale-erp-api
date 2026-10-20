import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { PlatformRoleGroupMenusService } from './platform-role-group-menus.service';
import { PlatformRoleGroupsController } from './platform-role-groups.controller';
import { PlatformRoleGroupsService } from './platform-role-groups.service';

describe('PlatformRoleGroupsController', () => {
  let controller: PlatformRoleGroupsController;
  let groups: Record<
    'list' | 'detail' | 'create' | 'update' | 'deletionCandidates' | 'remove',
    jest.Mock
  >;
  let menus: Record<'tree' | 'save' | 'preview', jest.Mock>;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const UPDATED_AT = '2026-10-15T01:00:00.000Z';
  const menuBody = { menus: [], updatedAt: UPDATED_AT };

  beforeEach(async () => {
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
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PlatformRoleGroupsController);
  });

  const calls = [
    ['list', 'read', () => controller.list()],
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
    ['deletionCandidates', 'read', () => controller.deletionCandidates('5')],
    [
      'remove',
      'delete',
      () => controller.remove(user, '5', { updatedAt: UPDATED_AT }),
    ],
  ] as const;

  it.each(calls)(
    '%s 는 가드로 MN000214 %s 권한 + 플랫폼 계정을 본다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(
            PlatformRoleGroupsController.prototype,
            method,
          )!.value as object,
        ),
      ).toEqual({
        menuCode: 'MN000214',
        action,
        platformOnly: true,
      });
    },
  );

  it.each(calls)(
    '%s 는 서비스에 user.id 를 넘긴다',
    async (method, __, call) => {
      await call();
      const called = [...Object.values(groups), ...Object.values(menus)].filter(
        (fn) => fn.mock.calls.length > 0,
      );
      expect(called).toHaveLength(1);
      const [args] = called[0].mock.calls as unknown[][];
      // 목록 · 삭제 후보는 호출자가 필요 없다 — 아무것도 받지 않거나 id 만 받는다.
      if (method === 'list') expect(args).toEqual([]);
      else if (method === 'deletionCandidates') expect(args).toEqual([5]);
      else expect(args[0]).toBe(user.id);
    },
  );

  it('id 와 본문을 서비스에 넘긴다', async () => {
    await controller.saveMenus(user, '5', menuBody);
    expect(menus.save).toHaveBeenCalledWith(9, 5, menuBody);
    await controller.remove(user, '7', {
      replacementRoleGroupId: 6,
      updatedAt: UPDATED_AT,
    });
    expect(groups.remove).toHaveBeenCalledWith(9, 7, {
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
      expect(groups.detail).not.toHaveBeenCalled();
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
    ['deletionCandidates', () => controller.deletionCandidates(BIG)],
    ['remove', () => controller.remove(user, BIG, { updatedAt: UPDATED_AT })],
  ] as const)('%s 도 범위 밖 id 는 DB 에 묻지 않고 404', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    for (const fn of [...Object.values(groups), ...Object.values(menus)])
      expect(fn).not.toHaveBeenCalled();
  });

  // 경로마다 가드가 같은 표시를 붙이지만, 가드를 빠뜨린 경로가 더해져도 직원 앱 토큰에 열리지 않게 클래스에도 둔다.
  it('관리자 토큰만 받는다', () => {
    expect(
      Reflect.getMetadata(USER_TYPES, PlatformRoleGroupsController),
    ).toEqual(['admin']);
  });
});
