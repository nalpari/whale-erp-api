import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractsService } from './contracts.service';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

// 임시저장만 지운다. 발송한 적이 없어 남길 기록이 없다고 보고 행을 지운다(2026-10-12 결정, 이력 · 근무 요일 · 당사자 포함).
// 보내기(ContractDeliveryService)는 따로 시험한다 — 여기서는 무엇을 넘기는지만 본다. 기본은 앱으로 받음(보낼 것 없음)
const delivery = {
  prepare: jest.fn<
    Promise<unknown>,
    [unknown, Record<string, unknown>, Date]
  >(),
  dispatch: jest.fn<Promise<boolean>, [unknown, number]>(),
};
beforeEach(() => {
  delivery.prepare.mockReset().mockResolvedValue(null);
  // 보냈거나 보낼 것이 없다(true). 그사이 초대가 무효가 돼 보내지 않은 경우는 false 로 따로 본다
  delivery.dispatch.mockReset().mockResolvedValue(true);
});

describe('ContractsService.remove (임시저장 삭제)', () => {
  let service: ContractsService;
  const calls: string[] = [];
  const step = (name: string, value: unknown = { count: 1 }) =>
    jest.fn(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  let tx: {
    $executeRaw: jest.Mock;
    contract: {
      findUnique: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
    contractWorkDay: { deleteMany: jest.Mock };
    contractParty: { deleteMany: jest.Mock };
    contractStatusHistory: { deleteMany: jest.Mock };
    staffMember: { deleteMany: jest.Mock; updateMany: jest.Mock };
  };
  let scope: { canManageStaffAt: jest.Mock };
  let prisma: { $transaction: jest.Mock; contract: { findUnique: jest.Mock } };

  beforeEach(async () => {
    calls.length = 0;
    scope = { canManageStaffAt: jest.fn().mockResolvedValue(true) };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
        }),
        deleteMany: step('contract'),
        count: jest.fn().mockResolvedValue(0),
      },
      contractWorkDay: { deleteMany: step('workDays') },
      contractParty: { deleteMany: step('party') },
      contractStatusHistory: { deleteMany: step('histories') },
      staffMember: {
        deleteMany: step('staffMember'),
        updateMany: step('unlink'),
      },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
      // 트랜잭션 밖 범위 확인(근무지)
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 11,
          staffMember: { account: { isHqSharingConsented: false } },
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: delivery },
        { provide: PERSONAL_DATA_KEY, useValue: null },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('근무 요일 · 당사자 · 이력을 먼저 지우고 계약을 지운 뒤, 그 계약에만 쓰인 초안 직원 레코드도 지운다', async () => {
    await service.remove(9, 7);

    expect(calls).toEqual([
      'workDays',
      'party',
      'histories',
      'contract',
      // 지울 레코드를 이전 재직 레코드로 가리키는 연결을 먼저 끊는다(WHALEERP-615)
      'unlink',
      'staffMember',
    ]);
    expect(tx.contractWorkDay.deleteMany).toHaveBeenCalledWith({
      where: { contractId: 7 },
    });
    expect(tx.contractParty.deleteMany).toHaveBeenCalledWith({
      where: { contractId: 7 },
    });
    expect(tx.contractStatusHistory.deleteMany).toHaveBeenCalledWith({
      where: { contractId: 7 },
    });
    // 읽은 뒤 다른 요청이 초안 저장으로 넘겼으면 0건 — 그때는 트랜잭션째 되돌린다
    expect(tx.contract.deleteMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'DRAFT' },
    });
    expect(tx.contract.count).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
    });
    // 가입 전(초안) 레코드만 지운다
    expect(tx.staffMember.deleteMany).toHaveBeenCalledWith({
      where: { staffMemberId: 3, joinStatus: 'DRAFT' },
    });
  });

  it('직원 행을 계약 행보다 먼저 잠근다 — 초안 직원 레코드를 지우므로', async () => {
    await service.remove(9, 7);
    // 직원 행(FOR NO KEY UPDATE) → 계약 행(FOR UPDATE) — 이어 쓰기 · 퇴직 확정 · 직원 앱 날인과 같은 순서(api #104)
    const sql = (tx.$executeRaw.mock.calls as unknown[][]).map((c) =>
      Array.isArray(c[0]) ? (c[0] as string[]).join('?') : '',
    );
    const staff = sql.findIndex((s) =>
      /FROM staff_members .* FOR NO KEY UPDATE$/.test(s),
    );
    const contract = sql.findIndex((s) =>
      /FROM contracts .* FOR UPDATE$/.test(s),
    );
    expect(staff).toBeGreaterThanOrEqual(0);
    expect(staff).toBeLessThan(contract);
    expect((tx.$executeRaw.mock.calls as unknown[][])[staff][1]).toBe(3);
  });

  it('직원 레코드에 다른 계약이 남아 있으면 레코드는 두고 계약만 지운다', async () => {
    tx.contract.count.mockResolvedValue(1);
    await service.remove(9, 7);
    expect(calls).toEqual(['workDays', 'party', 'histories', 'contract']);
  });

  it('없으면 404 — 트랜잭션을 열지 않는다', async () => {
    prisma.contract.findUnique.mockResolvedValue(null);
    await expect(service.remove(9, 7)).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('범위를 본 뒤 잠그기 전에 다른 요청이 지웠으면 404', async () => {
    tx.contract.findUnique.mockResolvedValue(null);
    await expect(service.remove(9, 7)).rejects.toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('계약 직원의 본사 제공 동의로 범위를 묻는다', async () => {
    prisma.contract.findUnique.mockResolvedValue({
      storeId: 11,
      staffMember: {
        account: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        },
      },
    });
    await service.remove(9, 7);
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, true);
  });

  it('가입 전(계정 없음) 직원의 계약은 동의하지 않은 것으로 범위를 묻는다', async () => {
    prisma.contract.findUnique.mockResolvedValue({
      storeId: 11,
      staffMember: { account: null },
    });
    await service.remove(9, 7);
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, false);
  });

  it('업무 범위 밖 계약은 없는 것과 같게 404 — 아무것도 지우지 않는다', async () => {
    scope.canManageStaffAt.mockResolvedValue(false);
    await expect(service.remove(9, 7)).rejects.toThrow(NotFoundException);
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, false);
    expect(calls).toEqual([]);
  });

  it('임시저장이 아니면 409 — 발송 대기 이후는 지우지 않는다', async () => {
    tx.contract.findUnique.mockResolvedValue({
      status: 'PENDING_SEND',
      staffMemberId: 3,
      storeId: 11,
    });
    await expect(service.remove(9, 7)).rejects.toThrow(ConflictException);
    expect(calls).toEqual([]);
  });

  it('읽은 뒤 상태가 바뀌어 계약 삭제가 0건이면 409 (앞서 지운 것은 트랜잭션이 되돌린다)', async () => {
    tx.contract.deleteMany = step('contract', { count: 0 });
    await expect(service.remove(9, 7)).rejects.toThrow(ConflictException);
    expect(calls).not.toContain('staffMember');
  });
});
