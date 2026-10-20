import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './access-messages';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import {
  MENU_PERMISSION,
  MenuPermission,
  MenuPermissionGuard,
} from './menu-permission.guard';

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
      [MENU_PERMISSION]: {
        menuCode: 'MN000010',
        action: 'update',
      },
    };
    user = { type: 'admin', id: 7, loginId: 'bpmaster1', sid: 21 };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          roleGroupId: 3,
          roleTypeCode: 'BM',
          bpCode: { isPlatform: false },
        }),
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
      select: {
        roleGroupId: true,
        roleTypeCode: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: {
        roleGroupId: 3,
        isDeleted: false,
        OR: [{ isUpdatable: true }],
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
    metadata[MENU_PERMISSION] = {
      menuCode: 'MN000010',
      action,
    };
    await guard.canActivate(context());
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: [{ [column]: true }] }) as unknown,
    });
  });

  it('동작을 여럿 받으면 그중 하나만 있어도 통과한다', async () => {
    metadata[MENU_PERMISSION] = {
      menuCode: 'MN000002',
      action: ['create', 'update'],
    };
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: [{ isCreatable: true }, { isUpdatable: true }],
      }) as unknown,
    });
  });

  it('표시에 메뉴 코드가 없으면 막는다 — SetMetadata 로 직접 단 표시도 메뉴 조건 없이 통과하지 않게', async () => {
    metadata[MENU_PERMISSION] = { action: 'read' };
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
    expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
  });

  it('동작 목록이 비면 막는다 — 메뉴 판정 없이 통과하지 않게', async () => {
    metadata[MENU_PERMISSION] = {
      menuCode: 'MN000010',
      action: [],
    };
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
    expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
  });

  describe('플랫폼 관리자만(platformOnly)', () => {
    beforeEach(() => {
      metadata[MENU_PERMISSION] = {
        menuCode: 'MN000213',
        action: 'read',
        platformOnly: true,
      };
    });

    it.each(['PM', 'PA'])(
      '플랫폼 BP 의 %s 는 메뉴 권한이 있으면 통과한다',
      async (roleTypeCode) => {
        prisma.adminAccount.findFirst.mockResolvedValue({
          roleGroupId: 3,
          roleTypeCode,
          bpCode: { isPlatform: true },
        });
        await expect(guard.canActivate(context())).resolves.toBe(true);
      },
    );

    it.each([
      ['고객 BP 에 붙은 PM', 'PM', false],
      ['플랫폼 BP 의 BM', 'BM', true],
    ])(
      '%s 는 메뉴 권한이 있어도 접근 권한 403',
      async (_label, roleTypeCode, isPlatform) => {
        prisma.adminAccount.findFirst.mockResolvedValue({
          roleGroupId: 3,
          roleTypeCode,
          bpCode: { isPlatform },
        });
        await expect(guard.canActivate(context())).rejects.toThrow(
          new ForbiddenException(ACCESS_DENIED_MESSAGE),
        );
      },
    );

    it('메뉴 권한이 없으면 플랫폼 계정이어도 접근 권한 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleGroupId: 3,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: true },
      });
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
    });
  });

  describe('표시 — 데코레이터에 쓴 그대로 남긴다', () => {
    const metaOf = (decorator: MethodDecorator) => {
      class Target {
        handler() {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        Target.prototype,
        'handler',
      )!;
      decorator(Target.prototype, 'handler', descriptor);
      return Reflect.getMetadata(
        MENU_PERMISSION,
        descriptor.value as object,
      ) as unknown;
    };

    it('동작 하나 — { menuCode, action } (기존 경로의 표시와 같은 모양)', () => {
      expect(metaOf(MenuPermission('MN000005', 'read'))).toEqual({
        menuCode: 'MN000005',
        action: 'read',
      });
    });

    // 메뉴 코드가 undefined 면 Prisma 가 메뉴 조건을 빼 아무 메뉴 권한으로나 통과한다. 상수의 순환 import 로도
    // 생길 수 있으니 요청이 아니라 클래스를 읽을 때(부팅) 실패하게 한다.
    it.each([
      ['undefined', undefined],
      ['빈 문자열', ''],
      ['형식이 다름', 'MN0002'],
      ['접두가 다름', 'PM000001'],
    ])('메뉴 코드가 %s 이면 데코레이터를 만들 때 실패한다', (_label, code) => {
      expect(() => MenuPermission(code as unknown as string, 'read')).toThrow(
        '메뉴 코드',
      );
    });

    it('동작 목록이 비면 데코레이터를 만들 때 실패한다', () => {
      expect(() => MenuPermission('MN000002', [])).toThrow('동작');
    });

    it('여러 동작 · 플랫폼 전용 — 준 것만 더한다', () => {
      expect(
        metaOf(
          MenuPermission('MN000213', ['create', 'update'], {
            platformOnly: true,
          }),
        ),
      ).toEqual({
        menuCode: 'MN000213',
        action: ['create', 'update'],
        platformOnly: true,
      });
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
