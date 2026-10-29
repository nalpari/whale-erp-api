import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { StaffBirthDateController } from './staff-birth-date.controller';
import { StaffBirthDateService } from './staff-birth-date.service';

describe('StaffBirthDateController', () => {
  let controller: StaffBirthDateController;
  let birthDates: { correct: jest.Mock };
  let scope: { canManageStaffMember: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin9', sid: 1 };
  const body = { birthDate: '1991-06-18' };

  beforeEach(async () => {
    birthDates = { correct: jest.fn().mockResolvedValue(undefined) };
    scope = { canManageStaffMember: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [StaffBirthDateController],
      providers: [
        { provide: StaffBirthDateService, useValue: birthDates },
        { provide: AdminScopeService, useValue: scope },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(StaffBirthDateController);
  });

  it('직원 정보 관리(MN000005) 수정 권한 가드를 거치고 경로에는 덮는 메타데이터가 없다', () => {
    expect(
      Reflect.getMetadata(MENU_PERMISSION, StaffBirthDateController),
    ).toEqual({ action: 'update' });
    expect(Reflect.getMetadata(USER_TYPES, StaffBirthDateController)).toEqual([
      'admin',
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, StaffBirthDateController),
    ).toContain(MenuPermissionGuard);
    const handler = Object.getOwnPropertyDescriptor(
      StaffBirthDateController.prototype,
      'correct',
    )!.value as object;
    for (const key of [MENU_PERMISSION, IS_PUBLIC, USER_TYPES])
      expect(Reflect.getMetadata(key, handler)).toBeUndefined();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(204);
  });

  it('관리자 ID · 직원 ID · 생년월일을 서비스에 넘긴다', async () => {
    await controller.correct(admin, '42', body);

    expect(scope.canManageStaffMember).toHaveBeenCalledWith(9, 42);
    expect(birthDates.correct).toHaveBeenCalledWith(9, 42, '1991-06-18');
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])(
    'ID 가 1..2147483647 밖(%p)이면 범위를 묻기 전에 404',
    async (rawId) => {
      await expect(
        controller.correct(admin, rawId, body),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(scope.canManageStaffMember).not.toHaveBeenCalled();
    },
  );

  it('관리 범위 밖 · 본사 제공 동의로 가린 직원은 없는 직원과 같은 404 이고 서비스를 부르지 않는다', async () => {
    scope.canManageStaffMember.mockResolvedValue(false);

    await expect(controller.correct(admin, '42', body)).rejects.toThrow(
      '직원을 찾을 수 없습니다.',
    );
    expect(birthDates.correct).not.toHaveBeenCalled();
  });
});
