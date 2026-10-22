import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { StaffMemberWorkSchedulesController } from './staff-member-work-schedules.controller';
import { StaffMemberWorkSchedulesService } from './staff-member-work-schedules.service';

describe('StaffMemberWorkSchedulesController', () => {
  let controller: StaffMemberWorkSchedulesController;
  let service: { list: jest.Mock };
  const admin = { type: 'admin' as const, id: 9, loginId: 'admin', sid: 1 };

  beforeEach(async () => {
    service = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, totalWorkMinutes: 0 }),
    };
    const module = await Test.createTestingModule({
      controllers: [StaffMemberWorkSchedulesController],
      providers: [
        { provide: StaffMemberWorkSchedulesService, useValue: service },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(StaffMemberWorkSchedulesController);
  });

  it('직원 자원 아래이고 직원 정보 관리(/staff-members) 조회 권한 가드를 거친다 — 근무스케줄 메뉴는 서비스가 본다', () => {
    const cls = StaffMemberWorkSchedulesController;
    expect(Reflect.getMetadata(PATH_METADATA, cls)).toBe('staff-members');
    expect(Reflect.getMetadata(MENU_PERMISSION, cls)).toEqual({
      action: 'read',
    });
    expect(Reflect.getMetadata(USER_TYPES, cls)).toEqual(['admin']);
    expect(Reflect.getMetadata(GUARDS_METADATA, cls)).toContain(
      MenuPermissionGuard,
    );
    const route = Object.getOwnPropertyDescriptor(cls.prototype, 'list')
      ?.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, route)).toBe(
      ':id/work-schedules',
    );
  });

  it('관리자 ID · 직원 ID · 쿼리를 넘긴다', async () => {
    const query = { period: 'ALL' as const, page: 2, pageSize: 50 };
    await controller.list(admin, '30', query);
    expect(service.list).toHaveBeenCalledWith(9, 30, query);
  });

  it.each(['abc', '0', '2147483648'])(
    'ID 형식 오류(%s)는 DB 에 묻기 전에 404',
    async (raw) => {
      await expect(controller.list(admin, raw, {})).rejects.toThrow(
        NotFoundException,
      );
      expect(service.list).not.toHaveBeenCalled();
    },
  );
});
