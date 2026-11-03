import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from './access-messages';
import { AdminLoginInfoService } from './admin-login-info.service';

describe('AdminLoginInfoService', () => {
  let service: AdminLoginInfoService;
  let prisma: {
    adminAccount: { findUnique: jest.Mock; findFirst: jest.Mock };
    roleGroup: { findUnique: jest.Mock };
    bpCode: { findUnique: jest.Mock };
    temporaryPassword: { findFirst: jest.Mock };
    menu: { findMany: jest.Mock };
    roleGroupMenu: { findMany: jest.Mock };
  };
  let scope: { listStores: jest.Mock };
  let codes: { forBp: jest.Mock };

  const bp = {
    bpCodeId: 2,
    bpCode: 'BP000123',
    tradeName: '웨일상사',
    isPlatform: false,
  };
  const account = (over: Record<string, unknown> = {}) => ({
    adminAccountId: 7,
    loginId: 'bpmaster1',
    name: '홍길동',
    email: 'a@whale.test',
    roleTypeCode: 'BM',
    roleGroupId: 3,
    isPasswordChangeRequired: false,
    joinPathCode: 'SIGNUP',
    termsAgreedAt: new Date('2026-10-01T00:00:00Z'),
    accountStatusCode: 'ACTIVE',
    bpCode: bp,
    ...over,
  });
  const store = {
    storeId: 5,
    storeCode: 'ST000001',
    name: '강남점',
    storeTypeCode: 'DIRECT',
    storeStatusCode: 'OPERATING',
  };

  beforeEach(async () => {
    prisma = {
      adminAccount: {
        findUnique: jest.fn().mockResolvedValue(account()),
        findFirst: jest.fn(),
      },
      roleGroup: { findUnique: jest.fn() },
      bpCode: { findUnique: jest.fn() },
      temporaryPassword: { findFirst: jest.fn().mockResolvedValue(null) },
      menu: {
        findMany: jest.fn().mockResolvedValue([
          {
            menuId: 1,
            parentMenuId: null,
            menuCode: 'MN000001',
            name: '홈',
            url: '/',
            depth: 1,
            sortOrder: 1,
          },
        ]),
      },
      roleGroupMenu: {
        findMany: jest.fn().mockResolvedValue([
          {
            menuId: 1,
            isReadable: true,
            isCreatable: true,
            isUpdatable: false,
            isDeletable: false,
          },
        ]),
      },
    };
    scope = { listStores: jest.fn().mockResolvedValue([store]) };
    codes = {
      forBp: jest.fn().mockResolvedValue({
        SERVICE: [{ value: 'WHALE_ERP', label: 'Whale ERP', order: 1 }],
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminLoginInfoService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: CodesService, useValue: codes },
      ],
    }).compile();
    service = module.get(AdminLoginInfoService);
  });

  it('계정 · 메뉴(+권한) · 관리 점포 · 그 BP 공통코드를 한 번에 준다', async () => {
    await expect(service.get(7)).resolves.toEqual({
      account: {
        adminAccountId: 7,
        loginId: 'bpmaster1',
        name: '홍길동',
        email: 'a@whale.test',
        roleTypeCode: 'BM',
        bp,
        isPasswordChangeRequired: false,
        temporaryPasswordExpiresAt: null,
        isTermsAgreementRequired: false,
      },
      menus: [
        {
          menuCode: 'MN000001',
          name: '홈',
          url: '/',
          depth: 1,
          permission: {
            read: true,
            create: true,
            update: false,
            delete: false,
          },
          children: [],
        },
      ],
      stores: [store],
      codes: {
        SERVICE: [{ value: 'WHALE_ERP', label: 'Whale ERP', order: 1 }],
      },
    });
    expect(codes.forBp).toHaveBeenCalledWith('BP000123');
    expect(scope.listStores).toHaveBeenCalledWith(7);
  });

  it('사용 중 메뉴 중 사용 중 서비스의 것만, 계정 권한 그룹의 권한만 읽는다', async () => {
    await service.get(7);
    expect(prisma.menu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isDeleted: false,
          status: 'ACTIVE',
          serviceCode: { in: ['WHALE_ERP'] },
        },
        select: expect.objectContaining({ serviceCode: true }) as unknown,
      }),
    );
    expect(prisma.roleGroupMenu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roleGroupId: 3,
          isDeleted: false,
          roleGroup: { isDeleted: false },
        },
      }),
    );
  });

  it('플랫폼등록 계정이 약관에 동의하지 않았으면 약관 동의가 필요하다', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue(
      account({ joinPathCode: 'PLATFORM_REGISTERED', termsAgreedAt: null }),
    );
    const info = await service.get(7);
    expect(info.account.isTermsAgreementRequired).toBe(true);
  });

  it('임시 비밀번호로 들어온 강제 변경 대상은 그 만료 시각을 준다', async () => {
    const expiresAt = new Date('2026-10-13T04:00:00Z');
    prisma.adminAccount.findUnique.mockResolvedValue(
      account({ isPasswordChangeRequired: true }),
    );
    prisma.temporaryPassword.findFirst.mockResolvedValue({ expiresAt });

    const info = await service.get(7);

    expect(info.account.temporaryPasswordExpiresAt).toEqual(expiresAt);
    expect(prisma.temporaryPassword.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          adminAccountId: 7,
          usedAt: { not: null },
          invalidatedAt: null,
          isDeleted: false,
        },
      }),
    );
  });

  it('플랫폼 계정의 관리 점포는 빈 목록 — BP 를 골라 일한다', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue(
      account({ bpCode: { ...bp, bpCode: 'BP000000', isPlatform: true } }),
    );
    const info = await service.get(7);
    expect(info.stores).toEqual([]);
    expect(scope.listStores).not.toHaveBeenCalled();
  });

  it('없거나 삭제된 계정이면 401', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue(null);
    await expect(service.get(7)).rejects.toThrow(UnauthorizedException);
    prisma.adminAccount.findUnique.mockResolvedValue({
      ...account(),
      isDeleted: true,
    });
    await expect(service.get(7)).rejects.toThrow(UnauthorizedException);
  });

  // 관리자 웹은 이 경로의 「사용할 수 없는 계정」 403 에 로그아웃시킨다 — 삭제가 먼저 401 로 갈라져야 한다.
  it('지웠으면서 탈퇴한 계정은 403 이 아니라 401', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue(
      account({ isDeleted: true, accountStatusCode: 'WITHDRAWN' }),
    );
    await expect(service.get(7)).rejects.toThrow(UnauthorizedException);
  });

  it('사용중지 · 탈퇴한 계정이면 403 — 화면 정보를 주지 않는다', async () => {
    for (const accountStatusCode of ['INACTIVE', 'WITHDRAWN']) {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ accountStatusCode }),
      );
      await expect(service.get(7)).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
    }
    expect(codes.forBp).not.toHaveBeenCalled();
  });

  // 관리자 웹이 새로고침 · 메뉴 이동 · 창 포커스 때 묻는다 — 바뀌었으면 login-info 를 다시 받는다.
  describe('version — 로그인 정보 버전', () => {
    const at = (ms: number) => new Date(1_790_000_000_000 + ms);
    const row = (menuId: number, ms = 0, isDeleted = false) => ({
      menuId,
      updatedAt: at(ms),
      isDeleted,
    });
    // 메뉴 행은 위치(상위 · 순서 · 단계)도 담는다 — 옮기기는 updatedAt 을 원래 값으로 두기 때문이다.
    const menu = (
      menuId: number,
      ms = 0,
      isDeleted = false,
      position: {
        parentMenuId?: number | null;
        sortOrder?: number;
        depth?: number;
      } = {},
    ) => ({
      ...row(menuId, ms, isDeleted),
      parentMenuId: null as number | null,
      sortOrder: menuId,
      depth: 1,
      ...position,
    });
    const state = () => ({
      account: { updatedAt: at(0), roleGroupId: 3, bpCodeId: 2 },
      group: { updatedAt: at(0), isDeleted: false },
      groupMenus: [row(1), row(2)],
      menus: [menu(1), menu(2), menu(3)],
      bp: { updatedAt: at(0) },
    });
    const versionOf = async (s: ReturnType<typeof state>) => {
      prisma.adminAccount.findFirst.mockResolvedValue(s.account);
      prisma.roleGroup.findUnique.mockResolvedValue(s.group);
      prisma.roleGroupMenu.findMany.mockResolvedValue(s.groupMenus);
      prisma.menu.findMany.mockResolvedValue(s.menus);
      prisma.bpCode.findUnique.mockResolvedValue(s.bp);
      return (await service.version(7)).version;
    };

    it('같은 상태면 같은 값 — 22자 base64url', async () => {
      const a = await versionOf(state());
      const b = await versionOf(state());
      expect(a).toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('사용 중 · 지우지 않은 내 계정을 읽고, 그 그룹 · 그룹 메뉴(지운 행 포함) · 메뉴 전체 · 소속 BP 를 본다', async () => {
      await versionOf(state());
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            adminAccountId: 7,
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
          },
        }),
      );
      expect(prisma.roleGroup.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roleGroupId: 3 } }),
      );
      expect(prisma.roleGroupMenu.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roleGroupId: 3 },
          orderBy: { menuId: 'asc' },
        }),
      );
      // 지운 · 사용중지 메뉴도 담는다 — 사용 중이던 메뉴가 지워지거나 꺼져도 값이 바뀌어야 한다.
      expect(prisma.menu.findMany).toHaveBeenCalledWith({
        select: {
          menuId: true,
          updatedAt: true,
          isDeleted: true,
          parentMenuId: true,
          sortOrder: true,
          depth: true,
        },
        orderBy: { menuId: 'asc' },
      });
      expect(prisma.bpCode.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { bpCodeId: 2 } }),
      );
    });

    const changes: [string, (s: ReturnType<typeof state>) => void][] = [
      ['계정', (s) => (s.account.updatedAt = at(1))],
      ['권한 그룹', (s) => (s.group.updatedAt = at(1))],
      ['권한 그룹 지움', (s) => (s.group.isDeleted = true)],
      ['그룹 메뉴 추가', (s) => s.groupMenus.push(row(3))],
      ['그룹 메뉴 수정', (s) => (s.groupMenus[0] = row(1, 1))],
      ['그룹 메뉴 지움', (s) => (s.groupMenus[1] = row(2, 0, true))],
      ['그룹 메뉴 행이 빠짐', (s) => s.groupMenus.pop()],
      ['메뉴 수정', (s) => (s.menus[2] = menu(3, 1))],
      ['메뉴 추가', (s) => s.menus.push(menu(4))],
      ['메뉴 지움', (s) => (s.menus[0] = menu(1, 0, true))],
      // 플랫폼 메뉴 옮기기(PlatformMenusService.move)는 updatedAt 을 원래 값으로 둔다.
      [
        '메뉴 상위 옮김(updatedAt 그대로)',
        (s) => (s.menus[2] = menu(3, 0, false, { parentMenuId: 1, depth: 2 })),
      ],
      [
        '메뉴 순서 바뀜(updatedAt 그대로)',
        (s) => (s.menus[1] = menu(2, 0, false, { sortOrder: 9 })),
      ],
      ['소속 BP', (s) => (s.bp.updatedAt = at(1))],
    ];
    it.each(changes)('%s 가 바뀌면 값이 바뀐다', async (_, change) => {
      const before = await versionOf(state());
      const s = state();
      change(s);
      expect(await versionOf(s)).not.toBe(before);
    });

    // 최근 시각 · 개수만 보면 놓친다 — 늦게 커밋된 수정은 더 이른 updatedAt 을 가질 수 있다(점포 버전과 같은 이유).
    it('최근 시각 · 개수가 같아도 다른 행이 바뀌면 값이 바뀐다', async () => {
      const s1 = state();
      s1.menus = [menu(1, 5), menu(2, 0), menu(3, 0)];
      const s2 = state();
      s2.menus = [menu(1, 5), menu(2, 1), menu(3, 0)];
      expect(await versionOf(s1)).not.toBe(await versionOf(s2));
    });

    // 외래키가 있어 실제로는 없지만, 없으면 던지지 않고 그 자리를 비운 값으로 만든다.
    it('권한 그룹 · BP 행을 못 찾아도 값을 만든다 — 있을 때와는 다르다', async () => {
      const before = await versionOf(state());
      prisma.roleGroup.findUnique.mockResolvedValue(null);
      prisma.bpCode.findUnique.mockResolvedValue(null);
      const after = (await service.version(7)).version;
      expect(after).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(after).not.toBe(before);
    });

    it('없거나 지웠거나 사용 중이 아닌 계정이면 403 — 나머지는 읽지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.version(7)).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
      expect(prisma.menu.findMany).not.toHaveBeenCalled();
    });
  });

  // 관리자 웹이 점포 목록 버전(GET /bp-codes/:id/stores-version)이 바뀌었을 때 부른다 — 메뉴 · 공통코드 없이 점포만.
  describe('stores — 내 관리 점포만', () => {
    it('로그인 정보의 stores 와 같은 목록을 준다', async () => {
      await expect(service.stores(7)).resolves.toEqual([store]);
      expect(scope.listStores).toHaveBeenCalledWith(7);
    });

    it('플랫폼 계정은 빈 목록 — BP 를 골라 일한다', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(
        account({ bpCode: { ...bp, bpCode: 'BP000000', isPlatform: true } }),
      );
      await expect(service.stores(7)).resolves.toEqual([]);
      expect(scope.listStores).not.toHaveBeenCalled();
    });

    it('없거나 삭제된 계정이면 401', async () => {
      prisma.adminAccount.findUnique.mockResolvedValue(null);
      await expect(service.stores(7)).rejects.toThrow(UnauthorizedException);
      prisma.adminAccount.findUnique.mockResolvedValue({
        ...account(),
        isDeleted: true,
      });
      await expect(service.stores(7)).rejects.toThrow(UnauthorizedException);
    });
  });
});
