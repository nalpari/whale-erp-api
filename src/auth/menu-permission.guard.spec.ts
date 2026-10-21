import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './access-messages';
import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import {
  isMenuAction,
  MENU_PERMISSION,
  MenuPermission,
  MenuPermissionGuard,
  menuUrlOf,
  OTHER_BP_MESSAGE,
  TargetBp,
} from './menu-permission.guard';

/** 권한 행 — 메뉴의 서비스만 읽는다. 플랫폼 메뉴면 BP 를 판정하지 않는다. */
const ALLOWED = { menu: { serviceCode: 'PLATFORM' } };
const ROW_SELECT = { menu: { select: { serviceCode: true } } };

describe('MenuPermissionGuard', () => {
  let guard: MenuPermissionGuard;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { findFirst: jest.Mock };
    menu: { count: jest.Mock };
    bpCode: { findFirst: jest.Mock };
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
      roleGroupMenu: { findFirst: jest.fn().mockResolvedValue(ALLOWED) },
      menu: { count: jest.fn().mockResolvedValue(1) },
      bpCode: { findFirst: jest.fn() },
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
        bpCodeId: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
      select: ROW_SELECT,
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
    prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
  });

  it('사용 중인 계정이 아니면 계정 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
    );
    expect(prisma.roleGroupMenu.findFirst).not.toHaveBeenCalled();
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
    expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
      select: ROW_SELECT,
      where: expect.objectContaining({ OR: [{ [column]: true }] }) as unknown,
    });
  });

  it('동작을 여럿 받으면 그중 하나만 있어도 통과한다', async () => {
    metadata[MENU_PERMISSION] = {
      menuCode: 'MN000002',
      action: ['create', 'update'],
    };
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
      select: ROW_SELECT,
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

  // 'menuCode' 키가 있으면 메뉴 코드 방식이다 — 값이 비었다고 경로 방식으로 넘기면 다른 메뉴로 판정된다.
  it('menuCode 키가 있는데 undefined 면 경로로 넘어가지 않고 막는다 — SetMetadata 로 직접 단 표시도', async () => {
    metadata[MENU_PERMISSION] = { menuCode: undefined, action: 'read' };
    await expect(guard.canActivate(context())).rejects.toThrow(
      new ForbiddenException(ACCESS_DENIED_MESSAGE),
    );
    expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['동작이 아닌 원소', ['read', 'bogus']],
    ['동작이 아닌 문자열', 'bogus'],
    ['동작이 없음', undefined],
    ['Object 의 속성 이름', 'toString'],
  ])(
    '%s 가 든 표시면 막는다 — SetMetadata 로 직접 단 표시도 Prisma 500 이 아니라 403',
    async (_label, action) => {
      metadata[MENU_PERMISSION] = { menuCode: 'MN000010', action };
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
    },
  );

  describe('거절할 때 판정할 메뉴가 없으면 로그를 남긴다', () => {
    let error: jest.SpyInstance;
    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
    });
    afterEach(() => error.mockRestore());
    const firstLog = () => (error.mock.calls as unknown[][])[0][0];

    it('경로 방식 — 그 URL 의 사용 중 메뉴가 없으면 컨트롤러 이름 · URL 을 적고 403 은 그대로', async () => {
      metadata[MENU_PERMISSION] = { action: 'read' };
      prisma.menu.count.mockResolvedValue(0);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.menu.count).toHaveBeenCalledWith({
        where: { url: '/stores', isDeleted: false, status: 'ACTIVE' },
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(firstLog()).toEqual(expect.stringContaining('StoresLike'));
      expect(firstLog()).toEqual(expect.stringContaining('/stores'));
    });

    it('메뉴 코드 방식 — 그 코드의 사용 중 메뉴가 없으면 코드를 적는다', async () => {
      prisma.menu.count.mockResolvedValue(0);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.menu.count).toHaveBeenCalledWith({
        where: { menuCode: 'MN000010', isDeleted: false, status: 'ACTIVE' },
      });
      expect(firstLog()).toEqual(expect.stringContaining('MN000010'));
    });

    it('메뉴가 있으면 권한이 없는 것뿐이라 로그 없이 403', async () => {
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.menu.count).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    });

    it('메뉴 조회가 실패해도 응답은 403 이다 — 로그 때문에 500 이 되지 않게', async () => {
      prisma.menu.count.mockRejectedValue(new Error('db down'));
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('통과하면 메뉴를 다시 보지 않는다 — 조회는 거절 경로에서만 는다', async () => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue(ALLOWED);
      await expect(guard.canActivate(context())).resolves.toBe(true);
      expect(prisma.menu.count).not.toHaveBeenCalled();
    });
  });

  describe('isMenuAction — 네 동작만', () => {
    it.each(['read', 'create', 'update', 'delete'])('%s 는 동작이다', (v) => {
      expect(isMenuAction(v)).toBe(true);
    });
    it.each(['bogus', 'toString', 'hasOwnProperty', '', undefined, 1, null])(
      '%p 는 동작이 아니다',
      (v) => {
        expect(isMenuAction(v)).toBe(false);
      },
    );
  });

  describe('menuUrlOf — 컨트롤러 경로의 첫 단계', () => {
    it.each([
      ['stores', '/stores'],
      ['/stores/x', '/stores'],
      ['//code-groups/items', '/code-groups'],
      ['/', undefined],
      ['', undefined],
      [undefined, undefined],
      [['stores'], undefined],
    ])('%p → %p', (path, url) => {
      expect(menuUrlOf(path)).toBe(url);
    });
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
      expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
        select: ROW_SELECT,
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
      expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
        select: ROW_SELECT,
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
      expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith({
        select: ROW_SELECT,
        where: expect.objectContaining({
          menu: { url: '/code-groups', isDeleted: false, status: 'ACTIVE' },
        }) as unknown,
      });
    });

    it('권한 행이 없으면 접근 권한 403', async () => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
    });

    it('사용 중인 계정이 아니면 계정 403 — 판정 순서는 메뉴 코드 방식과 같다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(guard.canActivate(context())).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
      expect(prisma.roleGroupMenu.findFirst).not.toHaveBeenCalled();
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
      expect(prisma.roleGroupMenu.findFirst).not.toHaveBeenCalled();
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
      prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
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

    // 지금까지는 ['bogus'] 가 요청 때 COLUMN 에서 undefined 칸을 만들어 Prisma 500 이었다.
    it.each([
      ['경로 방식 배열', [['read', 'bogus']]],
      ['경로 방식 배열의 undefined', [['read', undefined]]],
      ['메뉴 코드 방식 배열', ['MN000002', ['bogus']]],
      ['메뉴 코드 방식 문자열', ['MN000002', 'bogus']],
    ])(
      '%s 에 동작이 아닌 값이 있으면 데코레이터를 만들 때 실패한다',
      (_label, args) => {
        const decorate = MenuPermission as unknown as (
          ...a: unknown[]
        ) => unknown;
        expect(() => decorate(...args)).toThrow('동작');
      },
    );

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

  describe('대상 BP(X-Bp-Code-Id) — WHALE_ERP 메뉴에서만', () => {
    /** 소속 BP — 플랫폼 계정은 1(플랫폼 BP), 나머지는 7. */
    const ACCOUNTS = {
      PM: { bpCodeId: 1, isPlatform: true },
      PA: { bpCodeId: 1, isPlatform: true },
      BM: { bpCodeId: 7, isPlatform: false },
      BA: { bpCodeId: 7, isPlatform: false },
      FM: { bpCodeId: 7, isPlatform: false },
      FA: { bpCodeId: 7, isPlatform: false },
    } as const;
    let request: {
      user: unknown;
      headers: Record<string, string | string[]>;
      bp?: unknown;
    };
    const call = (role: keyof typeof ACCOUNTS, header?: string | string[]) => {
      const { bpCodeId, isPlatform } = ACCOUNTS[role];
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleGroupId: 3,
        roleTypeCode: role,
        bpCodeId,
        bpCode: { isPlatform },
      });
      request = {
        user,
        headers: header === undefined ? {} : { 'x-bp-code-id': header },
      };
      return guard.canActivate({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => 'handler',
        getClass: () => controller,
      } as unknown as ExecutionContext);
    };

    beforeEach(() => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue({
        menu: { serviceCode: 'WHALE_ERP' },
      });
      // 고객 BP 7 · 8 은 있고, 그 밖(99)은 없다. 플랫폼 BP(1)는 isPlatform 조건에 걸려 없는 것과 같다.
      prisma.bpCode.findFirst.mockImplementation(
        ({ where }: { where: { bpCodeId: number } }) =>
          Promise.resolve(
            [7, 8].includes(where.bpCodeId)
              ? { bpCodeId: where.bpCodeId }
              : null,
          ),
      );
    });

    it.each(['PM', 'PA', 'BM', 'BA', 'FM', 'FA'] as const)(
      '%s — 헤더가 없으면 소속 BP',
      async (role) => {
        await expect(call(role)).resolves.toBe(true);
        expect(request.bp).toEqual({
          bpCodeId: ACCOUNTS[role].bpCodeId,
          isPlatformCaller: ACCOUNTS[role].isPlatform,
        });
        expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
      },
    );

    it.each(['BM', 'BA', 'FM', 'FA'] as const)(
      '%s — 소속 BP 헤더는 통과, 남의 BP · 없는 BP · 형식이 틀린 값은 403',
      async (role) => {
        await expect(call(role, '7')).resolves.toBe(true);
        expect(request.bp).toEqual({ bpCodeId: 7, isPlatformCaller: false });
        for (const other of ['8', '99', 'abc', '0'])
          await expect(call(role, other)).rejects.toThrow(
            new ForbiddenException(OTHER_BP_MESSAGE),
          );
        expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
      },
    );

    it('헤더가 배열로 오면 어느 BP 도 아니다 — BP 계정 403, 플랫폼 계정 404', async () => {
      await expect(call('BM', ['7', '8'])).rejects.toThrow(
        new ForbiddenException(OTHER_BP_MESSAGE),
      );
      await expect(call('PM', ['7', '8'])).rejects.toThrow(NotFoundException);
      expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
    });

    it.each(['PM', 'PA'] as const)(
      '%s — 고객 BP 헤더면 그 BP, 없는 BP · 플랫폼 BP · 형식이 틀린 값은 404',
      async (role) => {
        await expect(call(role, '8')).resolves.toBe(true);
        expect(request.bp).toEqual({ bpCodeId: 8, isPlatformCaller: true });
        expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
          where: { bpCodeId: 8, isDeleted: false, isPlatform: false },
          select: { bpCodeId: true },
        });
        for (const missing of ['99', '1', 'abc', '2147483648'])
          await expect(call(role, missing)).rejects.toThrow(NotFoundException);
      },
    );

    it('메뉴 권한이 없으면 BP 보다 먼저 403 — 헤더로 BP 가 있는지 떠볼 수 없다', async () => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
      await expect(call('PM', '99')).rejects.toThrow(
        new ForbiddenException(ACCESS_DENIED_MESSAGE),
      );
      expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
    });

    it.each(['PM', 'BM'] as const)(
      'PLATFORM 메뉴는 헤더를 무시한다 — %s 가 남의 · 없는 BP 를 보내도 통과하고 request.bp 를 두지 않는다',
      async (role) => {
        prisma.roleGroupMenu.findFirst.mockResolvedValue({
          menu: { serviceCode: 'PLATFORM' },
        });
        await expect(call(role, '99')).resolves.toBe(true);
        expect(request.bp).toBeUndefined();
        expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  describe('TargetBp', () => {
    // createParamDecorator 의 팩토리를 꺼내 부른다(Nest 가 라우트 인자에 쓰는 것과 같은 함수).
    const factoryOf = () => {
      class Probe {
        handler(@TargetBp() bp: unknown) {
          return bp;
        }
      }
      const meta = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        Probe,
        'handler',
      ) as Record<
        string,
        { factory: (data: unknown, ctx: ExecutionContext) => unknown }
      >;
      return Object.values(meta)[0].factory;
    };
    const ctxWith = (req: object) =>
      ({
        switchToHttp: () => ({ getRequest: () => req }),
        getClass: () => StoresLike,
        getHandler: () => ({ name: 'image' }),
      }) as unknown as ExecutionContext;

    it('가드가 정한 대상 BP 를 준다', () => {
      const bp = { bpCodeId: 8, isPlatformCaller: true };
      expect(factoryOf()(undefined, ctxWith({ bp }))).toBe(bp);
    });

    it('BP 판정이 없는 경로에서 쓰면 500 — 빠뜨린 가드를 소속 BP 로 메우지 않고, 어느 경로인지 로그에 남긴다', () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      expect(() => factoryOf()(undefined, ctxWith({}))).toThrow(
        InternalServerErrorException,
      );
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('StoresLike.image'),
      );
      logged.mockRestore();
    });
  });

  it('@MenuPermission 은 X-Bp-Code-Id 헤더를 openapi 에 싣는다', () => {
    class Probe {
      @MenuPermission('read')
      handler() {}
    }
    expect(
      Reflect.getMetadata(
        'swagger/apiParameters',
        Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!
          .value as object,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'X-Bp-Code-Id',
        in: 'header',
        required: false,
      }),
    ]);
  });
});
