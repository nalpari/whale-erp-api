import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAdminsService } from './platform-admins.service';

describe('PlatformAdminsController', () => {
  let controller: PlatformAdminsController;
  let permissions: { assert: jest.Mock };
  let scope: { isPlatformAdmin: jest.Mock };
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
  const caller = { adminAccountId: 9, roleTypeCode: 'PA', roleGroupId: 20 };
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
    permissions = { assert: jest.fn().mockResolvedValue(caller) };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
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
      providers: [
        { provide: PlatformAdminsService, useValue: admins },
        { provide: MenuPermissionsService, useValue: permissions },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PlatformAdminsController);
  });

  const calls = [
    ['list', 'read', () => controller.list(user, page)],
    ['roleGroups', 'read', () => controller.roleGroups(user)],
    ['detail', 'read', () => controller.detail(user, '5')],
    ['histories', 'read', () => controller.histories(user, '5', page)],
    [
      'isLoginIdAvailable',
      'create',
      () => controller.loginIdAvailability(user, { loginId: 'seojun01' }),
    ],
    ['create', 'create', () => controller.create(user, createBody)],
    ['update', 'update', () => controller.update(user, '5', updateBody)],
    ['remove', 'delete', () => controller.remove(user, '5')],
    ['resetPassword', 'update', () => controller.resetPassword(user, '5')],
  ] as const;

  it.each(calls)(
    '%s 는 메뉴 MN000213 의 %s 권한을 확인한다',
    async (_, action, call) => {
      await call();
      expect(permissions.assert).toHaveBeenCalledWith(9, 'MN000213', action);
    },
  );

  it.each(calls)(
    '권한이 없으면 %s 는 서비스를 부르지 않고 403',
    async (name, _, call) => {
      permissions.assert.mockRejectedValue(new ForbiddenException());

      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      expect(admins[name]).not.toHaveBeenCalled();
    },
  );

  // 권한 행이 BP 쪽 권한 그룹에 잘못 붙어도 BP 계정이 플랫폼 관리자를 다루지 못하게 한다.
  it.each(calls)(
    '플랫폼 마스터 · 플랫폼 관리자가 아니면 %s 는 서비스를 부르지 않고 403',
    async (name, _, call) => {
      permissions.assert.mockResolvedValue({ ...caller, roleTypeCode: 'BM' });
      scope.isPlatformAdmin.mockResolvedValue(false);

      await expect(call()).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(admins[name]).not.toHaveBeenCalled();
    },
  );

  // 역할은 PM · PA 여도 소속이 고객 BP 면 플랫폼 계정이 아니다 — 플랫폼 BP 소속까지 본다(isPlatformAdmin).
  it.each(calls)(
    '고객 BP 소속 PM 이면 %s 는 서비스를 부르지 않고 403',
    async (name, _, call) => {
      permissions.assert.mockResolvedValue({ ...caller, roleTypeCode: 'PM' });
      scope.isPlatformAdmin.mockResolvedValue(false);

      await expect(call()).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(scope.isPlatformAdmin).toHaveBeenCalledWith(9);
      expect(admins[name]).not.toHaveBeenCalled();
    },
  );

  it('확인한 호출자와 숫자 id 를 서비스에 넘긴다', async () => {
    await controller.update(user, '5', updateBody);
    await controller.resetPassword(user, '5');

    expect(admins.update).toHaveBeenCalledWith(caller, 5, updateBody);
    expect(admins.resetPassword).toHaveBeenCalledWith(caller, 5);
    expect(admins.roleGroups).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648'])(
    'id 가 %p 면 DB 에 묻기 전에 404',
    async (id) => {
      await expect(controller.detail(user, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.remove(user, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(admins.detail).not.toHaveBeenCalled();
      expect(admins.remove).not.toHaveBeenCalled();
    },
  );
});
