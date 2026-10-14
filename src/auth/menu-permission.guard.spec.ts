import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './access-messages';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { MENU_PERMISSION, MenuPermissionGuard } from './menu-permission.guard';

describe('MenuPermissionGuard', () => {
  let guard: MenuPermissionGuard;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
  };
  let metadata: Record<string, unknown>;
  let user: unknown;

  const context = () =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => 'handler',
      getClass: () => 'class',
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    metadata = {
      [MENU_PERMISSION]: { menuCode: 'MN000010', action: 'update' },
    };
    user = { type: 'admin', id: 7, loginId: 'bpmaster1', sid: 21 };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as Reflector;
    guard = new MenuPermissionGuard(
      reflector,
      prisma as unknown as PrismaService,
    );
  });

  it('요청마다 현재 권한 그룹의 그 메뉴 · 그 동작 권한을 본다', async () => {
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
      where: {
        adminAccountId: 7,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { roleGroupId: true },
    });
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: {
        roleGroupId: 3,
        isDeleted: false,
        isUpdatable: true,
        roleGroup: { isDeleted: false },
        menu: { menuCode: 'MN000010', isDeleted: false, status: 'ACTIVE' },
      },
    });
  });

  it('권한이 없으면 접근 권한 403', async () => {
    prisma.roleGroupMenu.count.mockResolvedValue(0);
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
  });

  it('사용 중인 계정이 아니면 계정 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
    );
    expect(prisma.roleGroupMenu.count).not.toHaveBeenCalled();
  });

  it('관리자 토큰이 아니면 403', async () => {
    user = { type: 'account', id: 7, email: 'a@test', sid: 1 };
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );
  });

  it.each([
    ['read', 'isReadable'],
    ['create', 'isCreatable'],
    ['delete', 'isDeletable'],
  ])('%s 는 %s 칸으로 판정한다', async (action, column) => {
    metadata[MENU_PERMISSION] = { menuCode: 'MN000010', action };
    await guard.canActivate(context());
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ [column]: true }) as unknown,
    });
  });

  it('메뉴 표시 없이 가드만 붙었으면 막는다 — 제한 장치가 조용히 열리지 않게', async () => {
    metadata = {};
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
  });
});
