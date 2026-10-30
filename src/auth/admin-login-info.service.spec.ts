import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLoginInfoService } from './admin-login-info.service';

describe('AdminLoginInfoService', () => {
  let service: AdminLoginInfoService;
  let prisma: {
    adminAccount: { findUnique: jest.Mock };
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
      adminAccount: { findUnique: jest.fn().mockResolvedValue(account()) },
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
