import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminScopeService, hidesPersonalData } from './admin-scope.service';

describe('AdminScopeService', () => {
  let scope: AdminScopeService;
  let prisma: {
    staffMember: { findUnique: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
    store: { findFirst: jest.Mock; findMany: jest.Mock };
    adminStoreMapping: { count: jest.Mock };
    bpCode: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      staffMember: { findUnique: jest.fn().mockResolvedValue({ storeId: 5 }) },
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          bpCodeId: 2,
          isAllStores: false,
          roleTypeCode: 'BA',
        }),
      },
      store: {
        findFirst: jest.fn().mockResolvedValue({ storeTypeCode: 'DIRECT' }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ storeId: 5, storeTypeCode: 'DIRECT' }]),
      },
      adminStoreMapping: { count: jest.fn().mockResolvedValue(1) },
      bpCode: { findFirst: jest.fn().mockResolvedValue({ bpCodeId: 7 }) },
    };
    const module = await Test.createTestingModule({
      providers: [
        AdminScopeService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    scope = module.get(AdminScopeService);
  });

  const can = () => scope.canManageStaffMember(9, 30);

  it('그 직원의 점포를 매핑으로 관리하면 된다', async () => {
    await expect(can()).resolves.toBe(true);
    expect(prisma.adminStoreMapping.count).toHaveBeenCalledWith({
      where: { adminAccountId: 9, storeId: 5, isDeleted: false },
    });
  });

  it('소속 BP 전체 점포를 관리하면 매핑을 보지 않는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      bpCodeId: 2,
      isAllStores: true,
      roleTypeCode: 'BM',
    });

    await expect(can()).resolves.toBe(true);
    expect(prisma.adminStoreMapping.count).not.toHaveBeenCalled();
  });

  it('점포가 관리자의 BP 것이 아니면 안 된다 — 전체 점포 관리자여도', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      bpCodeId: 2,
      isAllStores: true,
      roleTypeCode: 'BM',
    });
    prisma.store.findFirst.mockResolvedValue(null);

    await expect(can()).resolves.toBe(false);
    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: { storeId: 5, bpCodeId: 2, isDeleted: false },
      select: { storeTypeCode: true },
    });
  });

  it('매핑이 없거나 지워졌으면 안 된다', async () => {
    prisma.adminStoreMapping.count.mockResolvedValue(0);

    await expect(can()).resolves.toBe(false);
  });

  it('사용 중이 아니거나 지운 관리자 계정이면 안 된다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);

    await expect(can()).resolves.toBe(false);
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
      where: {
        adminAccountId: 9,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
  });

  it.each(['BM', 'BA'])(
    '%s 는 가맹 점포 직원을 다루지 못한다 — 목록에서 가린 직원이다(ATT-30)',
    async (roleTypeCode) => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode,
      });
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });

      await expect(can()).resolves.toBe(false);
    },
  );

  it('점포 유형을 모르면 본사 역할에게 가린다 — 틀릴 때 가리는 쪽', async () => {
    prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'UNKNOWN' });

    await expect(can()).resolves.toBe(false);
  });

  it.each(['FM', 'FA'])(
    '%s 는 자기 가맹 점포 직원을 다룬다',
    async (roleTypeCode) => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: false,
        roleTypeCode,
      });
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });

      await expect(can()).resolves.toBe(true);
    },
  );

  describe('canManageStaffAt — 점포로 묻는다(근로계약 근무지)', () => {
    it('관리하고 가려지지 않는 점포면 된다', async () => {
      await expect(scope.canManageStaffAt(9, 5)).resolves.toBe(true);
      expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
    });

    it('본사 역할에게 가맹 점포는 안 된다', async () => {
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });
      await expect(scope.canManageStaffAt(9, 5)).resolves.toBe(false);
    });

    it('관리하지 않는 점포면 안 된다', async () => {
      prisma.adminStoreMapping.count.mockResolvedValue(0);
      await expect(scope.canManageStaffAt(9, 5)).resolves.toBe(false);
    });
  });

  it('본사 역할도 가맹 점포 자체는 관리한다 — 가리는 것은 직원 개인이다', async () => {
    prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });

    await expect(scope.canManageStore(9, 5)).resolves.toBe(true);
  });

  describe('hidesPersonalData', () => {
    it.each([
      ['BM', 'FRANCHISE', true],
      ['BA', 'FRANCHISE', true],
      ['BM', undefined, true],
      ['BM', 'DIRECT', false],
      ['BA', 'DIRECT', false],
      ['FM', 'FRANCHISE', false],
      ['FA', 'FRANCHISE', false],
      ['PM', 'FRANCHISE', false],
    ] as const)('%s · %s → %s', (role, storeType, hidden) => {
      expect(hidesPersonalData(role, storeType)).toBe(hidden);
    });
  });

  it('없는 직원이면 안 된다', async () => {
    prisma.staffMember.findUnique.mockResolvedValue(null);

    await expect(can()).resolves.toBe(false);
  });

  describe('getManageableStores', () => {
    const get = () => scope.getManageableStores(9);

    it('역할과 점포를 준다 — 매핑 관리자는 삭제되지 않은 매핑의 점포만', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: false,
        roleTypeCode: 'BA',
      });

      await expect(get()).resolves.toEqual({
        roleTypeCode: 'BA',
        stores: [{ storeId: 5, storeTypeCode: 'DIRECT' }],
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select: { storeId: true, storeTypeCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('전체 점포 관리자는 매핑을 보지 않고 자기 BP 의 점포 전부', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode: 'BM',
      });

      await get();
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 2, isDeleted: false },
        select: { storeId: true, storeTypeCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('사용 중인 계정만 본다 — 없거나 미사용이면 null', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(get()).resolves.toBeNull();
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
      });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });

  describe('isPlatformAdmin', () => {
    it('사용 중인 플랫폼 BP 의 PM · PA 계정만 true — 역할이 고객 BP 계정에 잘못 붙어도 막는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 9 });
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(true);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
          roleTypeCode: { in: ['PM', 'PA'] },
          bpCode: { isPlatform: true },
        },
        select: { adminAccountId: true },
      });
    });

    it('아니면 false', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
    });
  });

  describe('listStores — canManageStore 와 같은 규칙의 목록', () => {
    const select = {
      storeId: true,
      storeCode: true,
      name: true,
      storeTypeCode: true,
      storeStatusCode: true,
    };
    const orderBy = [{ name: 'asc' }, { storeId: 'asc' }];

    it('매핑으로 관리하면 그 BP 의 매핑된 점포만', async () => {
      await scope.listStores(9);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select,
        orderBy,
      });
    });

    it('전체 점포 관리자는 그 BP 의 모든 점포', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
      });
      await scope.listStores(9);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 2, isDeleted: false },
        select,
        orderBy,
      });
    });

    it('사용 중인 계정이 아니면 빈 목록', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.listStores(9)).resolves.toEqual([]);
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listBpStores', () => {
    it('고객 BP 의 미삭제 점포 전체 — 운영 상태와 상관없이', async () => {
      prisma.store.findMany.mockResolvedValue([{ storeId: 1 }]);
      await expect(scope.listBpStores(7)).resolves.toEqual([{ storeId: 1 }]);
      expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
        where: { bpCodeId: 7, isDeleted: false, isPlatform: false },
        select: { bpCodeId: true },
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 7, isDeleted: false },
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeTypeCode: true,
          storeStatusCode: true,
        },
        orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
      });
    });

    it('없거나 삭제된 BP · 플랫폼 BP 면 null', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(scope.listBpStores(7)).resolves.toBeNull();
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });
});
