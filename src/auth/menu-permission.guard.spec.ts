import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './access-messages';
import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
} from '@nestjs/common';
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
  /** 요청이 닿은 컨트롤러 클래스 — 메뉴 코드 없는 표시는 이 경로의 첫 단계로 메뉴를 찾는다. */
  let controller: object;

  @Controller('stores')
  class StoresLike {
    @Get(':id/image')
    image() {}
  }

  const context = () =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => 'handler',
      getClass: () => controller,
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    metadata = {
      [MENU_PERMISSION]: {
        menuCode: 'MN000010',
        action: 'update',
      },
    };
    user = { type: 'admin', id: 7, loginId: 'bpmaster1', sid: 21 };
    controller = StoresLike;
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

  it('메뉴 코드가 빈 문자열이면 경로로 넘어가지 않고 막는다 — SetMetadata 로 직접 단 표시도', async () => {
    metadata[MENU_PERMISSION] = { menuCode: '', action: 'read' };
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

  describe('메뉴 코드 없는 표시 — 컨트롤러 경로의 첫 단계로 메뉴(menus.url)를 찾는다', () => {
    beforeEach(() => {
      metadata[MENU_PERMISSION] = { action: 'update' };
    });

    it('컨트롤러 경로가 메뉴 URL 이 되어 같은 count 쿼리 하나에서 본다', async () => {
      @Controller('platform-admins')
      class PlatformAdminsLike {}
      controller = PlatformAdminsLike;
      await expect(guard.canActivate(context())).resolves.toBe(true);
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledTimes(1);
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
        where: {
          roleGroupId: 3,
          isDeleted: false,
          OR: [{ isUpdatable: true }],
          roleGroup: { isDeleted: false },
          menu: { url: '/platform-admins', isDeleted: false, status: 'ACTIVE' },
        },
      });
    });

    it('하위 경로(:id/image)의 핸들러도 첫 단계(/stores) 메뉴로 판정한다', async () => {
      await guard.canActivate(context());
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          menu: { url: '/stores', isDeleted: false, status: 'ACTIVE' },
        }) as unknown,
      });
    });

    it('컨트롤러 경로가 여러 단계면 첫 단계만 쓴다', async () => {
      @Controller('/code-groups/items')
      class Nested {}
      controller = Nested;
      await guard.canActivate(context());
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          menu: { url: '/code-groups', isDeleted: false, status: 'ACTIVE' },
        }) as unknown,
      });
    });

    it('권한 행이 없으면 접근 권한 403', async () => {
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
    });

    it('사용 중인 계정이 아니면 계정 403 — 판정 순서는 메뉴 코드 방식과 같다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
      expect(prisma.roleGroupMenu.count).not.toHaveBeenCalled();
    });

    it('platformOnly 도 경로 방식에서 그대로 본다', async () => {
      metadata[MENU_PERMISSION] = { action: 'read', platformOnly: true };
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
    });

    // 메뉴를 정하지 못한 채 url 조건을 빼면 아무 메뉴 권한으로나 통과한다 — 열어 두지 않는다.
    it.each([
      ['@Controller 가 없음', () => class Plain {}],
      [
        '빈 문자열',
        () => {
          @Controller('')
          class Empty {}
          return Empty;
        },
      ],
      [
        "'/' 뿐(@Controller())",
        () => {
          @Controller()
          class Root {}
          return Root;
        },
      ],
      [
        '경로 배열',
        () => {
          @Controller(['stores', 'platform-admins'])
          class Many {}
          return Many;
        },
      ],
    ])('컨트롤러 경로가 %s 이면 접근 권한 403', async (_label, make) => {
      controller = make();
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
      expect(prisma.roleGroupMenu.count).not.toHaveBeenCalled();
    });
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

    it('경로 방식 — 동작만 주면 { action } (메뉴 코드 없음)', () => {
      expect(metaOf(MenuPermission('read'))).toEqual({ action: 'read' });
    });

    it('경로 방식 — 동작 배열 · 플랫폼 전용', () => {
      expect(
        metaOf(MenuPermission(['create', 'update'], { platformOnly: true })),
      ).toEqual({ action: ['create', 'update'], platformOnly: true });
    });

    it.each(['read', 'create', 'update', 'delete'] as const)(
      '첫 인자가 동작 %s 이면 경로 방식이다',
      (action) => {
        expect(metaOf(MenuPermission(action))).toEqual({ action });
      },
    );

    it('경로 방식에서 동작 배열이 비면 데코레이터를 만들 때 실패한다', () => {
      expect(() => MenuPermission([])).toThrow('동작');
    });

    it('동작 하나 — { menuCode, action } (메뉴 코드 방식은 그대로)', () => {
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
      expect(() => MenuPermission(code as `MN${string}`, 'read')).toThrow(
        '메뉴 코드',
      );
    });

    it('동작 목록이 비면 데코레이터를 만들 때 실패한다', () => {
      expect(() => MenuPermission('MN000002', [])).toThrow('동작');
    });

    // 경로 방식에 메뉴 코드 방식의 인자 꼴을 섞으면 두 번째 인자가 options 로 읽혀 platformOnly 가 조용히 빠진다.
    it.each([
      ['두 번째 인자가 동작', ['read', 'update']],
      ['두 번째 인자가 동작 배열', ['read', ['update']]],
      ['세 번째 인자가 있음', ['read', ['update'], { platformOnly: true }]],
    ])(
      '경로 방식인데 %s 이면 데코레이터를 만들 때 실패한다',
      (_label, args) => {
        const decorate = MenuPermission as unknown as (
          ...a: unknown[]
        ) => unknown;
        expect(() => decorate(...args)).toThrow('경로 방식');
      },
    );

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
