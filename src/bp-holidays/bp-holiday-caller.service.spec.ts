// expect.objectContaining 은 any 를 돌려준다 — 호출 인자의 일부만 보는 검사라 그대로 쓴다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BpHolidayCallerService } from './bp-holiday-caller.service';

describe('BpHolidayCallerService', () => {
  let service: BpHolidayCallerService;
  const prisma = {
    adminAccount: { findFirst: jest.fn() },
    roleGroupMenu: { findFirst: jest.fn() },
    adminStoreMapping: { findMany: jest.fn() },
    store: { findMany: jest.fn() },
  };

  const account = (over: Record<string, unknown> = {}) => ({
    adminAccountId: 5,
    bpCodeId: 7,
    roleGroupId: 70,
    roleTypeCode: 'BA',
    isAllStores: false,
    bpCode: { isPlatform: false },
    ...over,
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.roleGroupMenu.findFirst.mockResolvedValue({
      isCreatable: true,
      isUpdatable: false,
      isDeletable: true,
    });
    prisma.adminStoreMapping.findMany.mockResolvedValue([
      { storeId: 10 },
      { storeId: 11 },
    ]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        BpHolidayCallerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(BpHolidayCallerService);
  });

  it('일부 점포 BP 관리자는 매핑된 점포 범위와 메뉴 권한을 읽는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(account());
    const caller = await service.load(5, {
      bpCodeId: 7,
      isPlatformCaller: false,
    });
    expect(caller).toEqual({
      adminAccountId: 5,
      bpCodeId: 7,
      manageAll: false,
      storeScope: new Set([10, 11]),
      rights: { create: true, update: false, delete: true },
    });
    // 메뉴는 가드와 같이 경로(/bp-holidays)로 찾는다
    expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roleGroupId: 70,
          menu: expect.objectContaining({ url: '/bp-holidays' }),
        }),
      }),
    );
  });

  it('전체 점포 계정은 매핑을 읽지 않는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      account({ roleTypeCode: 'BM', isAllStores: true }),
    );
    const caller = await service.load(5, {
      bpCodeId: 7,
      isPlatformCaller: false,
    });
    expect(caller.storeScope).toBeNull();
    expect(caller.manageAll).toBe(true);
    expect(prisma.adminStoreMapping.findMany).not.toHaveBeenCalled();
  });

  it('플랫폼 계정은 고른 BP 를 다루고, 고르지 않았으면 400', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      account({
        bpCodeId: 1,
        roleTypeCode: 'PA',
        bpCode: { isPlatform: true },
      }),
    );
    await expect(
      service.load(5, { bpCodeId: 1, isPlatformCaller: true }),
    ).rejects.toThrow(BadRequestException);
    const caller = await service.load(5, {
      bpCodeId: 9,
      isPlatformCaller: true,
    });
    expect(caller).toMatchObject({
      bpCodeId: 9,
      manageAll: true,
      storeScope: null,
    });
  });

  it('쓸 수 없는 계정은 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(
      service.load(5, { bpCodeId: 7, isPlatformCaller: false }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('메뉴 행이 없으면 권한은 모두 false', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(account());
    prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
    const caller = await service.load(5, {
      bpCodeId: 7,
      isPlatformCaller: false,
    });
    expect(caller.rights).toEqual({
      create: false,
      update: false,
      delete: false,
    });
  });

  // 본사 점포(2026-11-17) — 가맹 계정은 전체 점포여도 본사를 뺀 점포가 범위다. BP 관리자 · 플랫폼은 그대로 전체.
  it('전체 점포 FA 는 본사를 뺀 그 BP 의 점포를 읽어 범위로 삼는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      account({ roleTypeCode: 'FA', isAllStores: true }),
    );
    prisma.store.findMany.mockResolvedValue([{ storeId: 20 }, { storeId: 21 }]);
    const caller = await service.load(5, {
      bpCodeId: 7,
      isPlatformCaller: false,
    });
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { bpCodeId: 7, isDeleted: false, isHq: false },
      select: { storeId: true },
    });
    expect(caller.storeScope).toEqual(new Set([20, 21]));
    expect(prisma.adminStoreMapping.findMany).not.toHaveBeenCalled();
  });

  it('전체 점포 BA 는 점포를 읽지 않고 범위 제한이 없다(본사 포함)', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      account({ roleTypeCode: 'BA', isAllStores: true }),
    );
    const caller = await service.load(5, {
      bpCodeId: 7,
      isPlatformCaller: false,
    });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
    expect(caller.storeScope).toBeNull();
  });

  it('플랫폼 계정은 점포를 읽지 않고 범위 제한이 없다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      account({
        bpCodeId: 1,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: true },
      }),
    );
    const caller = await service.load(5, {
      bpCodeId: 9,
      isPlatformCaller: true,
    });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
    expect(caller.storeScope).toBeNull();
  });
});
