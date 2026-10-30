import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractSendService } from './contract-send.service';
import { ContractsService } from './contracts.service';

// 근로계약의 대상 BP(WHALEERP-618). 가드가 정한 탭 BP 를 업무 범위(AdminScopeService)에 넘기고, 플랫폼 계정이 헤더 없이
// 부르면(가드가 소속 플랫폼 BP 를 둠) 범위를 보기 전에 400 이다. 범위 판정 자체는 admin-scope.service.spec 이 본다.
describe('근로계약 대상 BP', () => {
  const PLATFORM_BP = 1;
  const CUSTOMER_BP = 9;
  let prisma: {
    bpCode: { findFirst: jest.Mock };
    contract: { findUnique: jest.Mock };
  };
  let scope: { getManageableStores: jest.Mock; canManageStaffAt: jest.Mock };
  let contracts: ContractsService;
  let sender: ContractSendService;

  beforeEach(async () => {
    prisma = {
      bpCode: { findFirst: jest.fn() },
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 11,
          staffMember: { account: null, phone: '01090145563' },
        }),
      },
    };
    scope = {
      getManageableStores: jest
        .fn()
        .mockResolvedValue({ roleTypeCode: 'PM', stores: [] }),
      // 범위 밖이면 404 로 끝나 트랜잭션까지 가지 않는다 — 무엇을 넘겼는지만 본다
      canManageStaffAt: jest.fn().mockResolvedValue(false),
    };
    const module = await Test.createTestingModule({
      providers: [
        ContractsService,
        ContractSendService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: {} },
        // 상세의 신고 정보(taxProfile)가 쓴다 — 이 스펙은 범위 판정만 보므로 키는 없다
        { provide: PERSONAL_DATA_KEY, useValue: null },
      ],
    }).compile();
    contracts = module.get(ContractsService);
    sender = module.get(ContractSendService);
  });

  // 경로마다 서비스 진입점 — 본문은 BP 확인 뒤에 보므로 비워 둔다
  const routes: [string, (bp: TargetBpContext) => Promise<unknown>][] = [
    ['목록', (bp) => contracts.list(5, { page: 1, pageSize: 20 }, bp)],
    ['상세', (bp) => contracts.findOne(5, 7, bp)],
    ['작성', (bp) => contracts.create({} as never, 5, [], bp)],
    [
      '종이 계약 등록',
      (bp) => contracts.create({} as never, 5, [{} as never], bp),
    ],
    ['이어 쓰기', (bp) => contracts.update(5, 7, {} as never, [], bp)],
    ['당사자 정보 수정', (bp) => contracts.updateWorker(5, 7, {} as never, bp)],
    ['삭제', (bp) => contracts.remove(5, 7, bp)],
    ['날인본 내려받기', (bp) => contracts.documentDownloadUrl(5, 7, 3, bp)],
    ['재발송', (bp) => sender.send(5, 7, new Date(), {}, bp)],
    ['발송 대기 종료', (bp) => sender.end(5, 7, bp)],
  ];

  describe('플랫폼 계정이 헤더 없이 부르면(대상 = 소속 플랫폼 BP)', () => {
    const bp = { bpCodeId: PLATFORM_BP, isPlatformCaller: true };
    beforeEach(() =>
      prisma.bpCode.findFirst.mockResolvedValue({ isPlatform: true }),
    );

    it.each(routes)('%s — 범위를 보기 전에 400', async (_, call) => {
      const error = await call(bp).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe('근로계약을 볼 BP 를 골라 주세요.');
      expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
        where: { bpCodeId: PLATFORM_BP },
        select: { isPlatform: true },
      });
      expect(prisma.contract.findUnique).not.toHaveBeenCalled();
      expect(scope.getManageableStores).not.toHaveBeenCalled();
      expect(scope.canManageStaffAt).not.toHaveBeenCalled();
    });
  });

  describe('플랫폼 계정이 고객 BP 를 고르면', () => {
    const bp = { bpCodeId: CUSTOMER_BP, isPlatformCaller: true };
    beforeEach(() =>
      prisma.bpCode.findFirst.mockResolvedValue({ isPlatform: false }),
    );

    it('목록은 그 BP 로 관리 점포를 구한다', async () => {
      await expect(
        contracts.list(5, { page: 1, pageSize: 20 }, bp),
      ).resolves.toMatchObject({ items: [], total: 0 });
      expect(scope.getManageableStores).toHaveBeenCalledWith(5, bp);
    });

    it.each(
      routes.filter(
        ([name]) =>
          // 작성 · 이어 쓰기는 본문 검사(400)가 범위보다 먼저라 빼고, 목록은 따로 본다
          !['목록', '작성', '종이 계약 등록', '이어 쓰기'].includes(name),
      ),
    )('%s — 계약 범위를 그 BP 로 본다(범위 밖이면 404)', async (_, call) => {
      await expect(call(bp)).rejects.toBeInstanceOf(NotFoundException);
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(5, 11, false, bp);
    });
  });

  describe('BP · 가맹 계정은', () => {
    const bp = { bpCodeId: CUSTOMER_BP, isPlatformCaller: false };

    it('BP 를 다시 묻지 않고 가드가 정한 소속 BP 를 그대로 넘긴다', async () => {
      await contracts.list(5, { page: 1, pageSize: 20 }, bp);
      await expect(contracts.findOne(5, 7, bp)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
      expect(scope.getManageableStores).toHaveBeenCalledWith(5, bp);
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(5, 11, false, bp);
    });
  });
});
