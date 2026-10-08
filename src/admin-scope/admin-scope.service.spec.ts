import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminScopeService } from './admin-scope.service';

describe('AdminScopeService', () => {
  let scope: AdminScopeService;
  let prisma: {
    staffMember: { findUnique: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
    store: { count: jest.Mock };
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
      store: { count: jest.fn().mockResolvedValue(1) },
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
});
