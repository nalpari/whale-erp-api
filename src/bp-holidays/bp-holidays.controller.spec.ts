import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { BpHolidayCallerService } from './bp-holiday-caller.service';
import { BpHolidayChangesService } from './bp-holiday-changes.service';
import { BpHolidaysController } from './bp-holidays.controller';
import { BpHolidaysService } from './bp-holidays.service';

const actionOf = (method: keyof BpHolidaysController): unknown =>
  Reflect.getMetadata(
    MENU_PERMISSION,
    Object.getOwnPropertyDescriptor(BpHolidaysController.prototype, method)!
      .value as object,
  );

describe('BpHolidaysController', () => {
  let controller: BpHolidaysController;
  const caller = { adminAccountId: 1 };
  const callers = { load: jest.fn().mockResolvedValue(caller) };
  const holidays = { detail: jest.fn() };
  const changes = {
    update: jest.fn(),
    terminate: jest.fn(),
    remove: jest.fn(),
  };
  const user = { id: 1, type: 'admin' as const, loginId: 'a', sid: 1 };
  const bp = { bpCodeId: 7, isPlatformCaller: false };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [BpHolidaysController],
      providers: [
        { provide: BpHolidayCallerService, useValue: callers },
        { provide: BpHolidaysService, useValue: holidays },
        { provide: BpHolidayChangesService, useValue: changes },
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(BpHolidaysController);
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, BpHolidaysController)).toEqual([
      'admin',
    ]);
  });

  it.each([
    ['list', 'read'],
    ['histories', 'read'],
    ['detail', 'read'],
    ['overlaps', ['create', 'update']],
    ['create', 'create'],
    ['update', 'update'],
    ['terminate', 'delete'],
    ['remove', 'delete'],
  ] as const)(
    '%s 는 메뉴(경로로 찾는 MN000015) %j 권한으로 표시돼 있다',
    (method, action) => {
      expect(actionOf(method)).toEqual({ action });
    },
  );

  it.each([['0'], ['abc'], ['2147483648']])(
    '경로 ID %s 는 묻기 전에 404',
    async (raw) => {
      await expect(controller.detail(user, bp, raw, {})).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        controller.remove(user, bp, raw, {
          updatedAt: '2026-10-02T00:00:00.000Z',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(callers.load).not.toHaveBeenCalled();
    },
  );

  it('삭제도 읽은 updatedAt 을 넘긴다(쿼리)', async () => {
    await controller.remove(user, bp, '3', {
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(changes.remove).toHaveBeenCalledWith(
      caller,
      3,
      '2026-10-02T00:00:00.000Z',
      expect.any(Date),
    );
  });

  it('강제 종료는 읽은 updatedAt 을 넘긴다', async () => {
    await controller.terminate(user, bp, '3', {
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(changes.terminate).toHaveBeenCalledWith(
      caller,
      3,
      '2026-10-02T00:00:00.000Z',
      expect.any(Date),
    );
  });
});
