import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
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
  const admin: AuthUser = { id: 9, type: 'admin', email: 'a@test.invalid' };
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
    }).compile();
    controller = module.get(RetirementController);
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
