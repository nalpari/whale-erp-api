import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import type { AuthUser } from '../auth/auth.types';
import { RetirementController } from './retirement.controller';
import { RetirementService } from './retirement.service';

describe('RetirementController', () => {
  let controller: RetirementController;
  let retirement: {
    retire: jest.Mock;
    changeDate: jest.Mock;
    cancel: jest.Mock;
    preview: jest.Mock;
  };
  let scope: { canManageStaffMember: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin9', sid: 1 };
  const body = { retiredDate: '2026-10-31' };

  beforeEach(async () => {
    retirement = {
      retire: jest.fn().mockResolvedValue(undefined),
      changeDate: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      preview: jest.fn().mockResolvedValue({}),
    };
    scope = { canManageStaffMember: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [RetirementController],
      providers: [
        { provide: RetirementService, useValue: retirement },
        { provide: AdminScopeService, useValue: scope },
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(RetirementController);
  });

  // 미리 보기도 처리 · 변경 확인창에만 쓰므로 조회가 아니라 수정 권한이다.
  it('네 경로 모두 직원 정보 관리(MN000005) 수정 권한 가드를 거친다', () => {
    expect(Reflect.getMetadata(MENU_PERMISSION, RetirementController)).toEqual({
      action: 'update',
    });
    expect(Reflect.getMetadata(USER_TYPES, RetirementController)).toEqual([
      'admin',
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, RetirementController),
    ).toContain(MenuPermissionGuard);
    // 가드는 메뉴 권한 · 공개 · 토큰 종류를 경로 먼저, 클래스 나중으로 읽는다(getAllAndOverride). 경로에
    // MENU_PERMISSION · IS_PUBLIC · USER_TYPES 중 하나라도 붙으면 클래스의 판정을 덮으므로, 어느 메서드에도 없어야
    // 한다. 새 경로가 생겨도 빠지지 않게 이름을 적지 않고 프로토타입을 돈다. 메타데이터만 읽으므로 this 없이 꺼낸다.
    const names = Object.getOwnPropertyNames(
      RetirementController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(names).toEqual(
      expect.arrayContaining(['preview', 'retire', 'changeDate', 'cancel']),
    );
    for (const name of names) {
      const handler = Object.getOwnPropertyDescriptor(
        RetirementController.prototype,
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

  it('처리한 관리자와 읽은 ID · 날짜를 서비스에 넘긴다', async () => {
    await controller.retire(admin, '42', body);

    expect(scope.canManageStaffMember).toHaveBeenCalledWith(9, 42);
    expect(retirement.retire).toHaveBeenCalledWith(
      9,
      42,
      new Date('2026-10-31T00:00:00Z'),
    );
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])(
    'ID 가 1..2147483647 밖(%p)이면 범위를 묻기 전에 404',
    async (rawId) => {
      await expect(
        controller.retire(admin, rawId, body),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(scope.canManageStaffMember).not.toHaveBeenCalled();
    },
  );

  it('경계값 2147483647 은 받는다', async () => {
    await controller.cancel(admin, '2147483647');

    expect(retirement.cancel).toHaveBeenCalledWith(9, 2147483647);
  });

  it('관리 범위 밖이면 없는 직원과 같은 404 이고 서비스를 부르지 않는다', async () => {
    scope.canManageStaffMember.mockResolvedValue(false);

    for (const run of [
      () => controller.retire(admin, '42', body),
      () => controller.changeDate(admin, '42', body),
      () => controller.cancel(admin, '42'),
      () => controller.preview(admin, '42', body),
    ])
      await expect(run()).rejects.toThrow('직원을 찾을 수 없습니다');
    expect(retirement.retire).not.toHaveBeenCalled();
    expect(retirement.changeDate).not.toHaveBeenCalled();
    expect(retirement.cancel).not.toHaveBeenCalled();
    expect(retirement.preview).not.toHaveBeenCalled();
  });
});
