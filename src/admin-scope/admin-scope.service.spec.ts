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
  };

  beforeEach(async () => {
    prisma = {
      staffMember: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ storeId: 5, isHqSharingConsented: false }),
      },
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

  it.each(['BM', 'BA'])(
    '%s 도 본사 제공 동의한 가맹 점포 직원은 다룬다',
    async (roleTypeCode) => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode,
      });
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });
      prisma.staffMember.findUnique.mockResolvedValue({
        storeId: 5,
        isHqSharingConsented: true,
      });

      await expect(can()).resolves.toBe(true);
      expect(prisma.staffMember.findUnique).toHaveBeenCalledWith({
        where: { staffMemberId: 30 },
        select: { storeId: true, isHqSharingConsented: true },
      });
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
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(true);
      expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
    });

    it('본사 역할에게 가맹 점포는 안 된다', async () => {
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(false);
    });

    it('관리하지 않는 점포면 안 된다', async () => {
      prisma.adminStoreMapping.count.mockResolvedValue(0);
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(false);
    });
  });

  it('본사 역할도 가맹 점포 자체는 관리한다 — 가리는 것은 직원 개인이다', async () => {
    prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });

    await expect(scope.canManageStore(9, 5)).resolves.toBe(true);
  });

  describe('hidesPersonalData', () => {
    it.each([
      ['BM', 'FRANCHISE', false, true],
      ['BA', 'FRANCHISE', false, true],
      ['BM', undefined, false, true],
      ['BM', 'FRANCHISE', true, false],
      ['BA', 'FRANCHISE', true, false],
      ['BM', 'DIRECT', false, false],
      ['BA', 'DIRECT', false, false],
      ['FM', 'FRANCHISE', false, false],
      ['FA', 'FRANCHISE', false, false],
      ['PM', 'FRANCHISE', false, false],
    ] as const)(
      '%s · %s · 동의 %s → %s',
      (role, storeType, consented, hidden) => {
        expect(hidesPersonalData(role, storeType, consented)).toBe(hidden);
      },
    );
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
    it.each(['PM', 'PA'])('%s 면 된다', async (roleTypeCode) => {
      prisma.adminAccount.findFirst.mockResolvedValue({ roleTypeCode });
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(true);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { roleTypeCode: true },
      });
    });

    it('BP · 가맹 관리자거나 사용 중인 계정이 없으면 안 된다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ roleTypeCode: 'BM' });
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
    });
  });
});
