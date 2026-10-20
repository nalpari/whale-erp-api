import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { PlatformMenusController } from './platform-menus.controller';
import { PlatformMenusService } from './platform-menus.service';

describe('PlatformMenusController', () => {
  let controller: PlatformMenusController;
  let menus: Record<string, jest.Mock>;

  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const UPDATED_AT = '2026-10-16T01:00:00.000Z';
  const updateBody = {
    name: 'a',
    status: 'ACTIVE' as const,
    updatedAt: UPDATED_AT,
  };
  const moveBody = { parentMenuId: null, index: 0 };

  beforeEach(async () => {
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
      providers: [{ provide: PlatformMenusService, useValue: menus }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PlatformMenusController);
  });

  // 메뉴 권한 · 플랫폼 BP 의 PM · PA 판정은 가드(@MenuPermission … platformOnly)가 한다 — 여기서는 경로마다 표시만 본다.
  it.each([
    ['services', 'read'],
    ['tree', 'read'],
    ['detail', 'read'],
    ['create', 'create'],
    ['update', 'update'],
    ['move', 'update'], // 옮기기는 수정
  ] as const)(
    '%s 는 MN000215 %s 권한 · 플랫폼 관리자 전용으로 표시돼 있다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(
            PlatformMenusController.prototype,
            method,
          )!.value as object,
        ),
      ).toEqual({
        menuCode: 'MN000215',
        action,
        platformOnly: true,
      });
    },
  );

  it('호출자 id 와 경로 id 를 서비스에 넘긴다', async () => {
    await controller.update(user, '5', updateBody);
    expect(menus.update).toHaveBeenCalledWith(9, 5, updateBody);
    // 옮기기는 수정자를 남기지 않아 호출자를 넘기지 않는다.
    await controller.move('7', moveBody);
    expect(menus.move).toHaveBeenCalledWith(7, moveBody);
    await controller.tree({ serviceCode: 'POS' });
    expect(menus.tree).toHaveBeenCalledWith('POS');
    await controller.detail('3');
    expect(menus.detail).toHaveBeenCalledWith(3);
    const body = { serviceCode: 'PLATFORM', name: 'a' };
    await controller.create(user, body);
    expect(menus.create).toHaveBeenCalledWith(9, body);
  });

  it.each([
    ['detail', () => controller.detail('2147483648')],
    ['update', () => controller.update(user, '0', updateBody)],
    ['move', () => controller.move('abc', moveBody)],
  ] as const)('%s 는 범위 밖 id 를 DB 에 묻지 않고 404', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    for (const fn of Object.values(menus)) expect(fn).not.toHaveBeenCalled();
  });

  // 경로마다 가드가 같은 표시를 붙이지만, 가드를 빠뜨린 경로가 더해져도 직원 앱 토큰에 열리지 않게 클래스에도 둔다.
  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, PlatformMenusController)).toEqual([
      'admin',
    ]);
  });
});
