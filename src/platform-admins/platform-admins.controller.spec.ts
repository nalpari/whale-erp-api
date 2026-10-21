import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAdminsService } from './platform-admins.service';

describe('PlatformAdminsController', () => {
  let controller: PlatformAdminsController;
  let admins: Record<
    | 'list'
    | 'roleGroups'
    | 'detail'
    | 'histories'
    | 'isLoginIdAvailable'
    | 'create'
    | 'update'
    | 'remove'
    | 'resetPassword',
    jest.Mock
  >;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const page = { page: 1, pageSize: 20 };
  const createBody = {
    loginId: 'seojun01',
    name: '이서준',
    phone: '01012345678',
    email: 'seojun@whale.test',
    roleGroupId: 20,
  };
  const updateBody = {
    ...createBody,
    accountStatus: 'ACTIVE' as const,
    updatedAt: '2026-10-13T00:00:00.000Z',
  };

  beforeEach(async () => {
    admins = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, inactiveCount: 0 }),
      roleGroups: jest.fn().mockResolvedValue({ items: [] }),
      detail: jest.fn().mockResolvedValue({}),
      histories: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      isLoginIdAvailable: jest.fn().mockResolvedValue(true),
      create: jest
        .fn()
        .mockResolvedValue({ adminAccountId: 5, isMailSent: true }),
      update: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue({ isMailSent: true }),
    };
    const module = await Test.createTestingModule({
      controllers: [PlatformAdminsController],
      providers: [{ provide: PlatformAdminsService, useValue: admins }],
    })
      // 가드는 따로 시험한다(menu-permission.guard.spec). 여기서는 붙은 표시만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PlatformAdminsController);
  });

  // 메뉴 권한 · 플랫폼 계정 확인은 가드(@MenuPermission … platformOnly)가 핸들러보다 먼저 본다.
  it.each([
    ['list', 'read'],
    ['roleGroups', 'read'],
    ['detail', 'read'],
    ['histories', 'read'],
    ['loginIdAvailability', 'create'],
    ['create', 'create'],
    ['update', 'update'],
    ['remove', 'delete'],
    ['resetPassword', 'update'],
  ] as const)(
    '%s 는 메뉴 MN000213 의 %s 권한과 플랫폼 계정을 가드로 요구한다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(
            PlatformAdminsController.prototype,
            method,
          )?.value as object,
        ),
      ).toEqual({
        action,
        platformOnly: true,
      });
    },
  );

  it('호출자는 id 만 넘기고, 경로의 id 는 숫자로 바꿔 넘긴다', async () => {
    await controller.list(page);
    await controller.roleGroups(user);
    await controller.detail('5');
    await controller.histories('5', page);
    await controller.loginIdAvailability({ loginId: 'seojun01' });
    await controller.create(user, createBody);
    await controller.update(user, '5', updateBody);
    await controller.remove(user, '5');
    await controller.resetPassword(user, '5');

    expect(admins.list).toHaveBeenCalledWith(page);
    expect(admins.roleGroups).toHaveBeenCalledWith(9);
    expect(admins.detail).toHaveBeenCalledWith(5);
    expect(admins.histories).toHaveBeenCalledWith(5, page);
    expect(admins.isLoginIdAvailable).toHaveBeenCalledWith('seojun01');
    expect(admins.create).toHaveBeenCalledWith(9, createBody);
    expect(admins.update).toHaveBeenCalledWith(9, 5, updateBody);
    expect(admins.remove).toHaveBeenCalledWith(9, 5);
    expect(admins.resetPassword).toHaveBeenCalledWith(9, 5);
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648'])(
    'id 가 %p 면 DB 에 묻기 전에 404',
    async (id) => {
      await expect(async () => controller.detail(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.remove(user, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(admins.detail).not.toHaveBeenCalled();
      expect(admins.remove).not.toHaveBeenCalled();
    },
  );

  // 경로마다 가드가 같은 표시를 붙이지만, 가드를 빠뜨린 경로가 더해져도 직원 앱 토큰에 열리지 않게 클래스에도 둔다.
  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, PlatformAdminsController)).toEqual([
      'admin',
    ]);
  });
});
