import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { ContractsService } from './contracts.service';

// 임시저장만 지운다. 발송한 적이 없어 남길 기록이 없다고 보고 행을 지운다(2026-10-12 결정, 이력 · 근무 요일 · 당사자 포함).
describe('ContractsService.remove (임시저장 삭제)', () => {
  let service: ContractsService;
  const calls: string[] = [];
  const step = (name: string, value: unknown = { count: 1 }) =>
    jest.fn(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  let tx: {
    contract: {
      findUnique: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
    contractWorkDay: { deleteMany: jest.Mock };
    contractParty: { deleteMany: jest.Mock };
    contractStatusHistory: { deleteMany: jest.Mock };
    staffMember: { deleteMany: jest.Mock };
  };

  beforeEach(async () => {
    calls.length = 0;
    tx = {
      contract: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'DRAFT', staffMemberId: 3 }),
        deleteMany: step('contract'),
        count: jest.fn().mockResolvedValue(0),
      },
      contractWorkDay: { deleteMany: step('workDays') },
      contractParty: { deleteMany: step('party') },
      contractStatusHistory: { deleteMany: step('histories') },
      staffMember: { deleteMany: step('staffMember') },
    };
    const prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('근무 요일 · 당사자 · 이력을 먼저 지우고 계약을 지운 뒤, 그 계약에만 쓰인 초안 직원 레코드도 지운다', async () => {
    await service.remove(7);

    expect(calls).toEqual([
      'workDays',
      'party',
      'histories',
      'contract',
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

  it('직원 레코드에 다른 계약이 남아 있으면 레코드는 두고 계약만 지운다', async () => {
    tx.contract.count.mockResolvedValue(1);
    await service.remove(7);
    expect(calls).toEqual(['workDays', 'party', 'histories', 'contract']);
  });

  it('없으면 404', async () => {
    tx.contract.findUnique.mockResolvedValue(null);
    await expect(service.remove(7)).rejects.toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('임시저장이 아니면 409 — 발송 대기 이후는 지우지 않는다', async () => {
    tx.contract.findUnique.mockResolvedValue({
      status: 'PENDING_SEND',
      staffMemberId: 3,
    });
    await expect(service.remove(7)).rejects.toThrow(ConflictException);
    expect(calls).toEqual([]);
  });

  it('읽은 뒤 상태가 바뀌어 계약 삭제가 0건이면 409 (앞서 지운 것은 트랜잭션이 되돌린다)', async () => {
    tx.contract.deleteMany = step('contract', { count: 0 });
    await expect(service.remove(7)).rejects.toThrow(ConflictException);
    expect(calls).not.toContain('staffMember');
  });
});
