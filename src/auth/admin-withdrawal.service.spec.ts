import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminWithdrawalService } from './admin-withdrawal.service';

describe('AdminWithdrawalService.getEligibility', () => {
  let service: AdminWithdrawalService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock; count: jest.Mock };
    bpCode: { findUniqueOrThrow: jest.Mock };
    store: { count: jest.Mock; findMany: jest.Mock };
    contract: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      adminAccount: { findFirst: jest.fn(), count: jest.fn() },
      bpCode: { findUniqueOrThrow: jest.fn() },
      store: { count: jest.fn(), findMany: jest.fn() },
      contract: { count: jest.fn() },
    };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminWithdrawalService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile()
    ).get(AdminWithdrawalService);
  });

  it('BP 마스터가 아니면 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BA',
      bpCodeId: 1,
    });
    await expect(service.getEligibility(1)).rejects.toThrow(ForbiddenException);
  });

  it('탈퇴한 계정이면 404', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null); // isDeleted:false 필터로 이미 걸러짐
    await expect(service.getEligibility(1)).rejects.toThrow(NotFoundException);
  });

  it('BP명·하위 관리자 수·점포 수·진행중 계약 여부를 반환한다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(6);
    prisma.store.count.mockResolvedValue(11);
    // contracts 테이블은 1팀 stores 와 Prisma 관계로 잇지 않는다(schema.prisma 머리말) —
    // storeId 는 정수 칸만 있어 그 BP 의 점포 id 를 먼저 받아 와야 한다.
    prisma.store.findMany.mockResolvedValue([
      { storeId: 101 },
      { storeId: 102 },
    ]);
    prisma.contract.count.mockResolvedValue(1);

    const result = await service.getEligibility(1);

    expect(result).toEqual({
      bpName: '웨일분식',
      adminCount: 6,
      storeCount: 11,
      hasInProgressContract: true,
    });
    expect(prisma.bpCode.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      select: { tradeName: true },
    });
    expect(prisma.adminAccount.count).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        adminAccountId: { not: 1 },
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
      },
    });
    expect(prisma.store.count).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
    });
    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        storeId: { in: [101, 102] },
        status: {
          in: ['DRAFT', 'PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'],
        },
      },
    });
  });

  it('진행중 계약이 없으면 hasInProgressContract 는 false', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(0);
    prisma.store.count.mockResolvedValue(0);
    prisma.store.findMany.mockResolvedValue([]);
    prisma.contract.count.mockResolvedValue(0);

    const result = await service.getEligibility(1);

    expect(result.hasInProgressContract).toBe(false);
  });
});
