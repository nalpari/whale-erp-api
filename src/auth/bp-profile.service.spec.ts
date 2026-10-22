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
  let verifier: {
    verify: jest.Mock;
    readToken: jest.Mock;
    isBizRegistrationNumberTaken: jest.Mock;
  };
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    adminAccount: { findFirst: jest.Mock };
    bpCode: { findFirst: jest.Mock; updateMany: jest.Mock };
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
    verifier = {
      verify: jest.fn().mockResolvedValue('token'),
      readToken: jest.fn(),
      isBizRegistrationNumberTaken: jest.fn().mockResolvedValue(false),
    };
    prisma = {
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
      adminAccount: { findFirst: jest.fn().mockResolvedValue(account()) },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue(bp()),
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

  describe('requestVerification', () => {
    const input = {
      bizRegistrationNumber: '1058763602',
      bizCeoName: '김하늘',
      bizOpenDate: '2020-03-02',
    };

    it('BusinessVerificationService 로 중복(자신 제외)·국세청 확인만 보고 토큰을 돌려준다 — 저장은 하지 않는다', async () => {
      const result = await service.requestVerification(1, input);
      expect(verifier.verify).toHaveBeenCalledWith(
        {
          bizRegistrationNumber: '1058763602',
          bizCeoName: '김하늘',
          bizOpenDate: '2020-03-02',
        },
        1,
      );
      expect(result).toEqual({ verificationToken: 'token' });
      expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
    });

    it('인증이 실패하면(중복·불일치) 그대로 던진다', async () => {
      verifier.verify.mockRejectedValue(new ConflictException('dup'));
      await expect(
        service.requestVerification(1, input),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BM 이 아니면 403 — 국세청을 부르지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        account({ roleTypeCode: 'FM' }),
      );
      await expect(
        service.requestVerification(1, input),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(verifier.verify).not.toHaveBeenCalled();
    });

    it('계정이 없으면 404', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.requestVerification(1, input),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // 국세청 키 · 하루 할당량을 가입 · 점포 · MY PAGE 가 함께 쓴다 — StoreManagementService
    // .countNtsCall 과 같은 한도를 관리자별로 따로 센다(store-management.service.spec.ts
    // '국세청 호출 한도'와 같은 모양).
    describe('국세청 호출 한도', () => {
      let now: jest.SpyInstance;
      beforeEach(() => {
        now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      });
      afterEach(() => now.mockRestore());

      const verifyTimes = async (adminAccountId: number, times: number) => {
        for (let i = 0; i < times; i++)
          await service.requestVerification(adminAccountId, input);
      };

      it('한 관리자는 한 시간에 10번까지 — 11번째는 429 이고 국세청에 묻지 않는다', async () => {
        await verifyTimes(1, 10);
        await expect(
          service.requestVerification(1, input),
        ).rejects.toMatchObject({ status: 429 });
        expect(verifier.verify).toHaveBeenCalledTimes(10);
      });

      it('다른 관리자는 따로 세고, 한 시간이 지나면 다시 된다', async () => {
        await verifyTimes(1, 10);
        prisma.adminAccount.findFirst.mockResolvedValue(
          account({ bpCodeId: 2 }),
        );
        prisma.bpCode.findFirst.mockResolvedValue(bp({ bpCodeId: 2 }));
        await expect(service.requestVerification(2, input)).resolves.toEqual({
          verificationToken: 'token',
        });
        now.mockReturnValue(1_000_000 + 3_600_000);
        prisma.adminAccount.findFirst.mockResolvedValue(account());
        prisma.bpCode.findFirst.mockResolvedValue(bp());
        await expect(service.requestVerification(1, input)).resolves.toEqual({
          verificationToken: 'token',
        });
      });
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

    it('BM 이 아니면 403 — 트랜잭션 안의 판정도 같다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        account({ roleTypeCode: 'FM' }),
      );
      await expect(service.update(1, input)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
    });

    it('계정이 없으면 404', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.update(1, input)).rejects.toBeInstanceOf(
        NotFoundException,
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

    it('businessVerificationToken 이 없으면 사업자등록번호 · 대표자명 · 개업일자 · 인증일시를 건드리지 않는다', async () => {
      await service.update(1, input);
      expect(verifier.readToken).not.toHaveBeenCalled();
      const data = (
        prisma.bpCode.updateMany.mock.calls[0] as [{ data: object }]
      )[0].data;
      expect(Object.keys(data)).not.toContain('bizRegistrationNumber');
    });

    it('토큰이 만료·위조됐으면 트랜잭션을 열지 않는다 — 다른 항목도 저장되지 않는다', async () => {
      verifier.readToken.mockRejectedValue(new Error('expired'));
      await expect(
        service.update(1, { ...input, businessVerificationToken: 'bad' }),
      ).rejects.toThrow('expired');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
    });

    describe('businessVerificationToken 을 실었으면', () => {
      const biz = {
        bizRegistrationNumber: '1058763602',
        bizCeoName: '김하늘',
        bizOpenDate: '2020-03-02',
      };
      const withToken = { ...input, businessVerificationToken: 'tok' };

      beforeEach(() => {
        verifier.readToken.mockResolvedValue(biz);
      });

      it('토큰을 풀어 세 값과 인증일시를 같은 저장에 반영한다', async () => {
        await service.update(1, withToken);
        expect(verifier.readToken).toHaveBeenCalledWith('tok');
        expect(prisma.bpCode.updateMany).toHaveBeenCalledWith(
          partial({
            data: partial({
              bizRegistrationNumber: '1058763602',
              bizCeoName: '김하늘',
              bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
              bizVerifiedAt: anyDate,
            }),
          }),
        );
        const changes = (
          prisma.bpChangeHistory.createMany.mock.calls[0] as [
            { data: { field: string }[] },
          ]
        )[0].data;
        expect(changes.map((c) => c.field)).toEqual(
          expect.arrayContaining(['사업자등록번호', '대표자명', '개업일자']),
        );
      });

      it('쓰기 직전 다시 본 중복(자신 제외)이 있으면 409 — 저장하지 않는다', async () => {
        verifier.isBizRegistrationNumberTaken.mockResolvedValue(true);
        await expect(service.update(1, withToken)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(verifier.isBizRegistrationNumberTaken).toHaveBeenCalledWith(
          '1058763602',
          prisma,
          1,
        );
        expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
      });

      it('번호로 잠근 뒤에 중복을 다시 센다 — 점포 저장·가입과 같은 키', async () => {
        await service.update(1, withToken);
        const lockCall = prisma.$executeRaw.mock.calls.findIndex(
          (call: unknown[]) => call.slice(1).includes('stores:biz:1058763602'),
        );
        expect(lockCall).toBeGreaterThanOrEqual(0);
        const lockedAt: number =
          prisma.$executeRaw.mock.invocationCallOrder[lockCall];
        const checkedAt: number =
          verifier.isBizRegistrationNumberTaken.mock.invocationCallOrder[0];
        expect(lockedAt).toBeLessThan(checkedAt);
      });
    });
  });
});
