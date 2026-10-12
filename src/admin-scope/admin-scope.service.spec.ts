import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminScopeService } from './admin-scope.service';

describe('AdminScopeService', () => {
  let scope: AdminScopeService;
  let prisma: {
    staffMember: { findUnique: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
    store: { count: jest.Mock; findMany: jest.Mock };
    adminStoreMapping: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      staffMember: { findUnique: jest.fn().mockResolvedValue({ storeId: 5 }) },
      adminAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ bpCodeId: 2, isAllStores: false }),
      },
      store: {
        count: jest.fn().mockResolvedValue(1),
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
    });

    await expect(can()).resolves.toBe(true);
    expect(prisma.adminStoreMapping.count).not.toHaveBeenCalled();
  });

  it('점포가 관리자의 BP 것이 아니면 안 된다 — 전체 점포 관리자여도', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      bpCodeId: 2,
      isAllStores: true,
    });
    prisma.store.count.mockResolvedValue(0);

    await expect(can()).resolves.toBe(false);
    expect(prisma.store.count).toHaveBeenCalledWith({
      where: { storeId: 5, bpCodeId: 2, isDeleted: false },
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
      select: { bpCodeId: true, isAllStores: true },
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
});
