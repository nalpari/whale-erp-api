import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractsService } from './contracts.service';
import { UpdateWorkerDto } from './dto/update-worker.dto';

// 날인 전 근로자 정보 수정(WHALEERP-125 「본인 대조」 · 126, 2026-10-16)
describe('ContractsService.updateWorker', () => {
  let service: ContractsService;
  let scope: { canManageStaffAt: jest.Mock };
  let tx: {
    $executeRaw: jest.Mock;
    contract: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock<
        Promise<{ count: number }>,
        [Prisma.ContractUpdateManyArgs]
      >;
    };
    account: { findMany: jest.Mock };
    staffMember: {
      findFirst: jest.Mock;
      update: jest.Mock<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>;
    };
    contractParty: {
      upsert: jest.Mock<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>;
    };
    contractStatusHistory: {
      create: jest.Mock<
        Promise<unknown>,
        [Prisma.ContractStatusHistoryCreateArgs]
      >;
    };
  };
  let prisma: { $transaction: jest.Mock; contract: { findUnique: jest.Mock } };

  const PHONE = '01090145563';
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING_SIGNATURE',
    storeId: 11,
    staffMemberId: 3,
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: null,
    staffMember: { phone: PHONE, joinStatus: 'DRAFT' },
    contractWorkDays: [
      {
        weekday: 'MON',
        startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T13:00:00Z'),
      },
    ],
    ...over,
  });
  const dto = (over: Partial<UpdateWorkerDto> = {}): UpdateWorkerDto => ({
    name: '남도현',
    phone: PHONE,
    birthDate: '1998-07-12',
    gender: 'MALE',
    isForeigner: false,
    ...over,
  });

  beforeEach(async () => {
    scope = { canManageStaffAt: jest.fn().mockResolvedValue(true) };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        findUnique: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest
          .fn<Promise<{ count: number }>, [Prisma.ContractUpdateManyArgs]>()
          .mockResolvedValue({ count: 1 }),
      },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>(),
      },
      contractParty: {
        upsert: jest.fn<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>(),
      },
      contractStatusHistory: {
        create: jest.fn<
          Promise<unknown>,
          [Prisma.ContractStatusHistoryCreateArgs]
        >(),
      },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
      // 트랜잭션 밖 — 업무 범위 확인
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 11,
          staffMember: { isHqSharingConsented: false, phone: PHONE },
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('서명 대기면 근로자 정보를 고치고 발송 대기로 돌린다 — 서명 기한을 비우고 이력을 남긴다', async () => {
    await expect(
      service.updateWorker(9, 7, dto({ gender: 'FEMALE', isForeigner: true })),
    ).resolves.toEqual({ contractId: 7, staffMemberId: 3 });
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { signDeadlineAt: null, status: 'PENDING_SEND' },
    });
    expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'PENDING_SEND',
        actor: 'ADMIN',
      },
    });
    const [party] = tx.contractParty.upsert.mock.calls[0];
    expect(party.update).toMatchObject({
      enteredName: '남도현',
      enteredPhone: PHONE,
      enteredBirthDate: new Date('1998-07-12T00:00:00.000Z'),
      enteredGender: 'FEMALE',
      isForeigner: true,
    });
    // 번호가 그대로면 중복 · 겹침 · 초대 판별을 다시 하지 않는다
    expect(tx.contract.findMany).not.toHaveBeenCalled();
    expect(tx.account.findMany).not.toHaveBeenCalled();
  });

  it('수정 요청이어도 발송 대기로 돌린다', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ status: 'CORRECTION_REQUESTED' }),
    );
    await service.updateWorker(9, 7, dto());
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'CORRECTION_REQUESTED' },
      data: { signDeadlineAt: null, status: 'PENDING_SEND' },
    });
  });

  it('발송 대기면 상태는 그대로 두고 정보만 고친다', async () => {
    tx.contract.findUnique.mockResolvedValue(row({ status: 'PENDING_SEND' }));
    await service.updateWorker(9, 7, dto({ name: '남도연' }));
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: { name: '남도연', phone: PHONE },
    });
  });

  it.each(['DRAFT', 'SIGNED', 'REJECTED', 'EXPIRED', 'ENDED'])(
    '%s 이면 409 CONTRACT_STATUS_CONFLICT — 아무것도 쓰지 않는다',
    async (status) => {
      tx.contract.findUnique.mockResolvedValue(row({ status }));
      const error = await service
        .updateWorker(9, 7, dto())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
        status,
      });
      expect(tx.contractParty.upsert).not.toHaveBeenCalled();
    },
  );

  it('번호를 바꾸면 새 번호로 재직 확인 · 진행 중 계약 · 근무 시간 겹침 · 초대 유형 판별을 다시 한다', async () => {
    await service.updateWorker(9, 7, dto({ phone: '01011112222' }));
    expect(tx.staffMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: 11,
          phone: '01011112222',
          staffMemberId: { not: 3 },
        }) as object,
      }),
    );
    // 같은 점포 진행 중 계약(자기 빼고) · 다른 점포 근무 시간 겹침
    expect(tx.contract.findMany).toHaveBeenCalledTimes(2);
    expect(tx.account.findMany).toHaveBeenCalled();
    // 초대 유형(계정 없음 → 가입 초대)을 다시 남기고 발송 대기로
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: {
        signDeadlineAt: null,
        draftAction: 'SIGNUP_INVITE',
        status: 'PENDING_SEND',
      },
    });
    expect(tx.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: { name: '남도현', phone: '01011112222', candidateAccountId: null },
    });
    // 지금 번호와 새 번호를 둘 다 잠근다
    const locked = tx.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(locked).toEqual(
      expect.arrayContaining([`contracts:${PHONE}`, 'contracts:01011112222']),
    );
  });

  it('새 번호로 같은 점포 진행 중 계약이 있으면 409 CONTRACT_IN_PROGRESS', async () => {
    tx.contract.findMany.mockResolvedValueOnce([
      {
        contractId: 5,
        status: 'PENDING_SEND',
        staffMemberId: 8,
        startDate: null,
        endDate: null,
        staffMember: { name: '다른사람' },
      },
    ]);
    const error = await service
      .updateWorker(9, 7, dto({ phone: '01011112222' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CONTRACT_IN_PROGRESS',
    });
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });

  it('동의로만 보이는 관리자가 번호를 바꾸면 403 — 트랜잭션 전에 막는다', async () => {
    // 계약 직원의 동의로만 보인다 — 점포 단위 범위는 없다
    prisma.contract.findUnique.mockResolvedValue({
      storeId: 11,
      staffMember: { isHqSharingConsented: true, phone: PHONE },
    });
    scope.canManageStaffAt.mockImplementation(
      (_: number, __: number, consented: boolean) => Promise.resolve(consented),
    );
    await expect(
      service.updateWorker(9, 7, dto({ phone: '01011112222' })),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('가입 완료한 직원 레코드는 두고 계약 당사자 값만 고친다', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ staffMember: { phone: PHONE, joinStatus: 'JOINED' } }),
    );
    await service.updateWorker(9, 7, dto({ name: '남도연' }));
    expect(tx.staffMember.update).not.toHaveBeenCalled();
    expect(tx.contractParty.upsert).toHaveBeenCalled();
  });

  it('계약 시작일 기준 만 19세 미만이면 400', async () => {
    await expect(
      service.updateWorker(9, 7, dto({ birthDate: '2010-01-01' })),
    ).rejects.toThrow(BadRequestException);
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });
});
