import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMembersController } from './staff-members.controller';

describe('StaffMembersController', () => {
  let controller: StaffMembersController;
  let list: { list: jest.Mock; findOne: jest.Mock };
  const admin = { type: 'admin' as const, id: 9, loginId: 'admin', sid: 1 };

  beforeEach(async () => {
    list = { list: jest.fn(), findOne: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [StaffMembersController],
      providers: [{ provide: StaffMemberListService, useValue: list }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(StaffMembersController);
  });

  it('목록 · 상세 모두 직원 정보 관리(MN000005) 조회 권한 가드를 거친다', () => {
    expect(
      Reflect.getMetadata(MENU_PERMISSION, StaffMembersController),
    ).toEqual({ menuCode: 'MN000005', action: 'read' });
    expect(Reflect.getMetadata(USER_TYPES, StaffMembersController)).toEqual([
      'admin',
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, StaffMembersController),
    ).toContain(MenuPermissionGuard);
    // 경로에 붙은 표시는 클래스의 판정을 덮는다(getAllAndOverride). 어느 경로에도 없어야 한다.
    const names = Object.getOwnPropertyNames(
      StaffMembersController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(names).toEqual(expect.arrayContaining(['findAll', 'findOne']));
    for (const name of names) {
      const handler = Object.getOwnPropertyDescriptor(
        StaffMembersController.prototype,
        name,
      )!.value as object;
      for (const key of [MENU_PERMISSION, IS_PUBLIC, USER_TYPES])
        expect([name, key, Reflect.getMetadata(key, handler)]).toEqual([
          name,
          key,
          undefined,
        ]);
    }
  });

  it('관리자 ID 와 쿼리를 넘겨 결과를 그대로 낸다', async () => {
    list.list.mockResolvedValue({ items: [], total: 0 });
    await expect(controller.findAll(admin, { page: 2 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(list.list).toHaveBeenCalledWith(9, { page: 2 });
  });

  it('사용 중인 관리자가 아니면 403', async () => {
    list.list.mockResolvedValue(null);
    await expect(controller.findAll(admin, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('상세', () => {
    it('관리자 ID 와 직원 ID 를 넘겨 한 줄을 그대로 낸다', async () => {
      const item = { staffMemberId: 30, isMasked: false };
      list.findOne.mockResolvedValue(item);
      await expect(controller.findOne(admin, '30')).resolves.toBe(item);
      expect(list.findOne).toHaveBeenCalledWith(9, 30);
    });

    it('없거나 관리 범위 밖이거나 가려지는 직원은 404', async () => {
      list.findOne.mockResolvedValue(null);
      await expect(controller.findOne(admin, '30')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999', ''])(
      'ID 형식 오류 %p 는 DB 에 묻기 전에 404',
      async (raw) => {
        await expect(controller.findOne(admin, raw)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(list.findOne).not.toHaveBeenCalled();
      },
    );
  });
});
