import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { AuthUser } from './auth.types';
import { PasswordResetLinkAdminController } from './password-reset-link-admin.controller';
import { PasswordResetLinkService } from './password-reset-link.service';

describe('PasswordResetLinkAdminController', () => {
  let controller: PasswordResetLinkAdminController;
  let links: { issue: jest.Mock };
  let scope: { canManageStaffMember: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const issued = {
    issuedAt: new Date('2026-10-13T03:00:00Z'),
    expiresAt: new Date('2026-10-14T03:00:00Z'),
  };

  beforeEach(async () => {
    links = { issue: jest.fn().mockResolvedValue(issued) };
    scope = { canManageStaffMember: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [PasswordResetLinkAdminController],
      providers: [
        { provide: PasswordResetLinkService, useValue: links },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PasswordResetLinkAdminController);
  });

  it('보낸 관리자와 읽은 ID 로 범위를 확인하고 발급 결과를 그대로 돌려준다', async () => {
    await expect(controller.issue(admin, '42')).resolves.toEqual(issued);

    expect(scope.canManageStaffMember).toHaveBeenCalledWith(9, 42);
    expect(links.issue).toHaveBeenCalledWith(9, 42);
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])(
    'ID 가 1..2147483647 밖(%p)이면 범위를 묻기 전에 404',
    async (rawId) => {
      await expect(controller.issue(admin, rawId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scope.canManageStaffMember).not.toHaveBeenCalled();
      expect(links.issue).not.toHaveBeenCalled();
    },
  );

  it('경계값 2147483647 은 받는다', async () => {
    await controller.issue(admin, '2147483647');

    expect(links.issue).toHaveBeenCalledWith(9, 2147483647);
  });

  it('관리 범위 밖이면 없는 직원과 같은 404 이고 링크를 보내지 않는다', async () => {
    scope.canManageStaffMember.mockResolvedValue(false);

    await expect(controller.issue(admin, '42')).rejects.toThrow(
      '직원을 찾을 수 없습니다',
    );
    expect(links.issue).not.toHaveBeenCalled();
  });
});
