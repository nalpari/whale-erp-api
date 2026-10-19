import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { PlatformMenusController } from './platform-menus.controller';
import { PlatformMenusService } from './platform-menus.service';

describe('PlatformMenusController', () => {
  let controller: PlatformMenusController;
  let permissions: { assert: jest.Mock };
  let scope: { isPlatformAdmin: jest.Mock };
  let menus: Record<string, jest.Mock>;

  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const caller = { adminAccountId: 9, roleTypeCode: 'PA', roleGroupId: 2 };
  const UPDATED_AT = '2026-10-16T01:00:00.000Z';
  const updateBody = {
    name: 'a',
    status: 'ACTIVE' as const,
    updatedAt: UPDATED_AT,
  };
  const moveBody = { parentMenuId: null, index: 0 };

  beforeEach(async () => {
    permissions = { assert: jest.fn().mockResolvedValue(caller) };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    menus = {
      services: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      tree: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      detail: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ menuId: 1, menuCode: 'MN000223' }),
      update: jest.fn().mockResolvedValue(undefined),
      move: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [PlatformMenusController],
      providers: [
        { provide: PlatformMenusService, useValue: menus },
        { provide: MenuPermissionsService, useValue: permissions },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PlatformMenusController);
  });

  const calls = [
    ['services', 'read', () => controller.services(user)],
    ['tree', 'read', () => controller.tree(user, { serviceCode: 'PLATFORM' })],
    ['detail', 'read', () => controller.detail(user, '5')],
    [
      'create',
      'create',
      () => controller.create(user, { serviceCode: 'PLATFORM', name: 'a' }),
    ],
    ['update', 'update', () => controller.update(user, '5', updateBody)],
    ['move', 'update', () => controller.move(user, '5', moveBody)],
  ] as const;

  it.each(calls)('%s 는 MN000215 %s 권한을 본다', async (_, action, call) => {
    await call();
    expect(permissions.assert).toHaveBeenCalledWith(9, 'MN000215', action);
    expect(scope.isPlatformAdmin).toHaveBeenCalledWith(9);
  });

  it.each(calls)(
    '%s — 플랫폼 BP 의 사용 중 PM · PA 가 아니면 공용 문구로 403, 업무 서비스를 부르지 않는다',
    async (_, __, call) => {
      scope.isPlatformAdmin.mockResolvedValue(false);
      await expect(call()).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      for (const fn of Object.values(menus)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it('호출자와 id 를 서비스에 넘긴다', async () => {
    await controller.update(user, '5', updateBody);
    expect(menus.update).toHaveBeenCalledWith(caller, 5, updateBody);
    // 옮기기는 수정자를 남기지 않아 호출자를 넘기지 않는다(권한만 본다).
    await controller.move(user, '7', moveBody);
    expect(menus.move).toHaveBeenCalledWith(7, moveBody);
    await controller.tree(user, { serviceCode: 'POS' });
    expect(menus.tree).toHaveBeenCalledWith('POS');
    await controller.detail(user, '3');
    expect(menus.detail).toHaveBeenCalledWith(3);
    const body = { serviceCode: 'PLATFORM', name: 'a' };
    await controller.create(user, body);
    expect(menus.create).toHaveBeenCalledWith(caller, body);
  });

  it.each([
    ['detail', () => controller.detail(user, '2147483648')],
    ['update', () => controller.update(user, '0', updateBody)],
    ['move', () => controller.move(user, 'abc', moveBody)],
  ] as const)('%s 는 범위 밖 id 를 DB 에 묻지 않고 404', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    expect(permissions.assert).not.toHaveBeenCalled();
    for (const fn of Object.values(menus)) expect(fn).not.toHaveBeenCalled();
  });
});
