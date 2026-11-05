import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { StaffMemberSummaryController } from './staff-member-summary.controller';
import { StaffMemberSummaryService } from './staff-member-summary.service';

describe('StaffMemberSummaryController', () => {
  let controller: StaffMemberSummaryController;
  let summary: {
    contract: jest.Mock;
    workSchedules: jest.Mock;
    payslips: jest.Mock;
    todos: jest.Mock;
  };
  const admin = { type: 'admin' as const, id: 9, loginId: 'admin', sid: 1 };
  // 가드가 정한 탭 BP — 플랫폼 계정이 고른 고객 BP(BP · 가맹 계정이면 소속 BP)
  const bp = { bpCodeId: 3, isPlatformCaller: true };

  beforeEach(async () => {
    summary = {
      contract: jest.fn().mockResolvedValue({ contract: null }),
      workSchedules: jest.fn().mockResolvedValue({ items: [] }),
      payslips: jest.fn().mockResolvedValue({ unsentCount: 0 }),
      todos: jest.fn().mockResolvedValue({ total: 0 }),
    };
    const module = await Test.createTestingModule({
      controllers: [StaffMemberSummaryController],
      providers: [{ provide: StaffMemberSummaryService, useValue: summary }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(StaffMemberSummaryController);
  });

  it('직원 자원 아래이고 직원 정보 관리(/staff-members) 조회 권한 가드를 거친다 — 영역 메뉴는 서비스가 본다', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, StaffMemberSummaryController),
    ).toBe('staff-members');
    expect(
      Reflect.getMetadata(MENU_PERMISSION, StaffMemberSummaryController),
    ).toEqual({ action: 'read' });
    expect(
      Reflect.getMetadata(USER_TYPES, StaffMemberSummaryController),
    ).toEqual(['admin']);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, StaffMemberSummaryController),
    ).toContain(MenuPermissionGuard);
  });

  it('영역마다 따로 부른다 — 관리자 ID 와 직원 ID 를 넘긴다', async () => {
    await controller.contract(admin, '30', bp);
    await controller.workSchedules(
      admin,
      '30',
      { weekStart: '2026-10-21' },
      bp,
    );
    await controller.payslips(admin, '30', bp);
    await controller.todos(admin, '30', bp);
    expect(summary.contract).toHaveBeenCalledWith(9, 30, bp);
    expect(summary.workSchedules).toHaveBeenCalledWith(9, 30, '2026-10-21', bp);
    expect(summary.payslips).toHaveBeenCalledWith(9, 30, bp);
    expect(summary.todos).toHaveBeenCalledWith(9, 30, bp);
  });

  it.each(['abc', '0', '2147483648'])(
    'ID 형식 오류(%s)는 DB 에 묻기 전에 404',
    async (raw) => {
      for (const call of [
        () => controller.contract(admin, raw, bp),
        () => controller.workSchedules(admin, raw, {}, bp),
        () => controller.payslips(admin, raw, bp),
        () => controller.todos(admin, raw, bp),
      ])
        await expect(call()).rejects.toThrow(NotFoundException);
      for (const m of Object.values(summary)) expect(m).not.toHaveBeenCalled();
    },
  );
});
