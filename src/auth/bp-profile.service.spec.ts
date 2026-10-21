import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessVerificationService } from '../admin-signup/business-verification.service';
import { PrismaService } from '../prisma/prisma.service';
import { BpProfileService } from './bp-profile.service';

const anyDate = expect.any(Date) as Date;
const partial = (o: object) => expect.objectContaining(o) as object;

describe('BpProfileService', () => {
  let service: BpProfileService;
  let verifier: { verify: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    adminAccount: { findFirst: jest.Mock };
    bpCode: {
      findFirst: jest.Mock;
      findFirstOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    bpChangeHistory: { createMany: jest.Mock };
  };

  const updatedAt = new Date('2026-10-21T00:00:00Z');
  const account = (over: Record<string, unknown> = {}) => ({
    roleTypeCode: 'BM',
    bpCodeId: 1,
    ...over,
  });
  const bp = (over: Record<string, unknown> = {}) => ({
    bpCodeId: 1,
    tradeName: '웨일상사',
    bizRegistrationNumber: null,
    bizCeoName: null,
    bizOpenDate: null,
    bizCeoPhone: null,
    bizCeoEmail: null,
    bizZipCode: null,
    bizAddress: null,
    bizAddressDetail: null,
    bizCategory: null,
    bizItem: null,
    bizVerifiedAt: null,
    updatedAt,
    ...over,
  });

  beforeEach(async () => {
    verifier = { verify: jest.fn().mockResolvedValue('token') };
    prisma = {
      $transaction: jest.fn(),
      adminAccount: { findFirst: jest.fn().mockResolvedValue(account()) },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue(bp()),
        findFirstOrThrow: jest.fn().mockResolvedValue(bp()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bpChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
    );

    const module = await Test.createTestingModule({
      providers: [
        BpProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: BusinessVerificationService, useValue: verifier },
      ],
    }).compile();
    service = module.get(BpProfileService);
  });

  describe('get', () => {
    it('BM 이 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        account({ roleTypeCode: 'FM' }),
      );
      await expect(service.get(1)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('계정이 없으면 404', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.get(1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('BM 이면 BP 사업자정보를 돌려준다', async () => {
      const result = await service.get(1);
      expect(result.tradeName).toBe('웨일상사');
      expect(result.bizRegistrationNumber).toBe('');
      expect(result.bizOpenDate).toBeNull();
      expect(result.updatedAt).toBe(updatedAt);
    });
  });

  describe('update', () => {
    const input = {
      tradeName: '새 상호명',
      bizCeoPhone: '0212345678',
      updatedAt: updatedAt.toISOString(),
    };

    it('동시 수정이면 409', async () => {
      prisma.bpCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(1, input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('바뀐 값만 변경 이력에 남긴다', async () => {
      await service.update(1, input);
      expect(prisma.bpCode.updateMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 1,
          updatedAt: { gte: updatedAt, lt: anyDate },
        },
        data: partial({
          tradeName: '새 상호명',
          bizCeoPhone: '0212345678',
          updatedBy: 1,
        }),
      });
      const changes = (
        prisma.bpChangeHistory.createMany.mock.calls[0] as [
          { data: { field: string }[] },
        ]
      )[0].data;
      expect(changes.map((c) => c.field).sort()).toEqual(
        ['대표자 연락처', '상호명'].sort(),
      );
    });

    it('값이 그대로면 변경 이력을 남기지 않는다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ tradeName: '새 상호명', bizCeoPhone: '0212345678' }),
      );
      await service.update(1, input);
      expect(prisma.bpChangeHistory.createMany).not.toHaveBeenCalled();
    });
  });

  describe('verifyBusiness', () => {
    const input = {
      bizRegistrationNumber: '1058763602',
      bizCeoName: '김하늘',
      bizOpenDate: '2020-03-02',
      updatedAt: updatedAt.toISOString(),
    };

    it('BusinessVerificationService 로 중복·국세청 확인을 먼저 본다', async () => {
      await service.verifyBusiness(1, input);
      expect(verifier.verify).toHaveBeenCalledWith({
        bizRegistrationNumber: '1058763602',
        bizCeoName: '김하늘',
        bizOpenDate: '2020-03-02',
      });
    });

    it('인증이 실패하면 저장을 하지 않는다', async () => {
      verifier.verify.mockRejectedValue(new ConflictException('dup'));
      await expect(service.verifyBusiness(1, input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
    });

    it('동시 수정이면 409', async () => {
      prisma.bpCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.verifyBusiness(1, input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('성공하면 세 값과 인증일시를 반영하고 변경 이력을 남긴다', async () => {
      const saved = bp({
        bizRegistrationNumber: '1058763602',
        bizCeoName: '김하늘',
        bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
        bizVerifiedAt: new Date(),
      });
      prisma.bpCode.findFirstOrThrow.mockResolvedValue(saved);
      const result = await service.verifyBusiness(1, input);
      expect(result.bizRegistrationNumber).toBe('1058763602');
      expect(result.bizCeoName).toBe('김하늘');
      expect(result.bizOpenDate).toBe('2020-03-02');
      expect(result.bizVerifiedAt).not.toBeNull();
      expect(prisma.bpChangeHistory.createMany).toHaveBeenCalled();
    });
  });
});
