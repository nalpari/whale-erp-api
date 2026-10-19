import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

// 계약 중복 검사(WHALEERP-129)가 저장 · 이어 쓰기 흐름에 끼는 자리. 검사 함수 자체는 contract-duplicates.spec.
// 보내기(ContractDeliveryService)는 따로 시험한다 — 여기서는 무엇을 넘기는지만 본다. 기본은 앱으로 받음(보낼 것 없음)
const delivery = {
  prepare: jest.fn<
    Promise<unknown>,
    [unknown, Record<string, unknown>, Date]
  >(),
  dispatch: jest.fn<Promise<void>, [unknown, number]>(),
};
beforeEach(() => {
  delivery.prepare.mockReset().mockResolvedValue(null);
  delivery.dispatch.mockReset().mockResolvedValue(undefined);
});

describe('ContractsService 계약 중복 검사', () => {
  let service: ContractsService;
  let db: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    store: { findFirst: jest.Mock };
    account: { findMany: jest.Mock };
    staffMember: {
      findMany: jest.Mock;
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    contract: {
      findMany: jest.Mock<Promise<unknown>, [Prisma.ContractFindManyArgs]>;
      findUnique: jest.Mock;
      create: jest.Mock<Promise<unknown>, [Prisma.ContractCreateArgs]>;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    contractWorkDay: { deleteMany: jest.Mock; createMany: jest.Mock };
    contractParty: { deleteMany: jest.Mock; upsert: jest.Mock };
    contractStatusHistory: { deleteMany: jest.Mock; create: jest.Mock };
  };

  const dto = (over: Partial<CreateContractDto> = {}): CreateContractDto => ({
    name: '남도현',
    phone: '01090145563',
    birthDate: '1998-07-12',
    storeId: 11,
    jobTitle: '바리스타',
    employmentType: 'PART_TIME',
    contractMethod: 'ELECTRONIC',
    startDate: '2026-11-01',
    wageAmount: 11200,
    workDays: [{ weekday: 'MON', startTime: '10:00', endTime: '16:00' }],
    payMonth: 'NEXT_MONTH',
    payDay: 10,
    isHealthPensionInsured: true,
    isEmploymentInjuryInsured: true,
    ...over,
  });

  // 진행 중 계약 조회와 다른 점포 계약 조회가 같은 contract.findMany 라 where 로 가른다.
  const contractRows = (inProgress: unknown[], otherStores: unknown[] = []) =>
    db.contract.findMany.mockImplementation((args) =>
      Promise.resolve(
        typeof args.where?.storeId === 'number' ? inProgress : otherStores,
      ),
    );
  const t = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);
  const overlapping = {
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: null,
    staffMember: { retiredDate: null },
    contractWorkDays: [
      { weekday: 'MON', startTime: t('12:00'), endTime: t('18:00') },
    ],
  };

  beforeEach(async () => {
    db = {
      $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) =>
        work(db),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
      store: { findFirst: jest.fn().mockResolvedValue({ storeId: 11 }) },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: {
        findMany: jest.fn().mockResolvedValue([]),
        // 첫 번째는 재직 확인, 두 번째는 다시 쓸 가입 전 레코드 — 기본은 둘 다 없다
        findFirst: jest
          .fn<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>()
          .mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          staffMemberId: 3,
          contracts: [{ contractId: 7 }],
        }),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      contract: {
        findMany: jest
          .fn<Promise<unknown>, [Prisma.ContractFindManyArgs]>()
          .mockResolvedValue([]),
        // 이어 쓰는 계약 · 대체할 계약을 잠근 뒤 다시 읽은 값. 기본은 같은 점포 · 같은 번호의 임시저장이다.
        findUnique: jest.fn().mockResolvedValue({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        }),
        create: jest
          .fn<Promise<unknown>, [Prisma.ContractCreateArgs]>()
          .mockResolvedValue({ contractId: 20 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contractWorkDay: { deleteMany: jest.fn(), createMany: jest.fn() },
      contractParty: { deleteMany: jest.fn(), upsert: jest.fn() },
      contractStatusHistory: { deleteMany: jest.fn(), create: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: db },
        {
          provide: AdminScopeService,
          useValue: { canManageStaffAt: jest.fn().mockResolvedValue(true) },
        },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: delivery },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  describe('저장 (POST)', () => {
    it('같은 점포에 진행 중 계약이 있으면 409 로 묻고 아무것도 만들지 않는다', async () => {
      contractRows([
        {
          contractId: 5,
          status: 'PENDING_SEND',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);

      const run = service.create(dto(), 1);
      await expect(run).rejects.toThrow(ConflictException);
      await expect(run).rejects.toMatchObject({
        response: {
          code: 'CONTRACT_IN_PROGRESS',
          contracts: [{ contractId: 5, status: 'PENDING_SEND' }],
        },
      });
      expect(db.contract.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          storeId: 11,
          status: {
            in: [
              'DRAFT',
              'PENDING_SEND',
              'PENDING_SIGNATURE',
              'CORRECTION_REQUESTED',
            ],
          },
          staffMember: { phone: '01090145563' },
        },
      });
      expect(db.staffMember.create).not.toHaveBeenCalled();
      expect(db.contract.create).not.toHaveBeenCalled();
    });

    it('대체를 확인하면 기존 계약을 닫고, 그 가입 전 레코드에 새 계약을 잇는다', async () => {
      contractRows([
        {
          contractId: 5,
          status: 'PENDING_SEND',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);
      db.staffMember.findFirst
        .mockResolvedValueOnce(null) // 재직 확인
        .mockResolvedValueOnce({ staffMemberId: 2 }); // 다시 쓸 레코드
      db.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        storeId: 11,
        staffMember: { phone: '01090145563' },
      });

      await expect(
        service.create(dto({ replaceContractIds: [5] }), 1),
      ).resolves.toEqual({ contractId: 20, staffMemberId: 2 });

      expect(db.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: 5, status: 'PENDING_SEND' },
        data: { status: 'ENDED' },
      });
      expect(db.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 2 },
        data: expect.objectContaining({
          name: '남도현',
          jobTitle: '바리스타',
        }) as unknown,
      });
      expect(db.contract.create.mock.calls[0][0].data).toMatchObject({
        staffMemberId: 2,
        status: 'PENDING_SEND',
        contractStatusHistories: {
          create: { toStatus: 'PENDING_SEND', actor: 'ADMIN' },
        },
      });
      expect(db.staffMember.create).not.toHaveBeenCalled();
      // 새 계약이 쓰는 레코드라 지울 후보가 없다
      expect(db.staffMember.deleteMany).not.toHaveBeenCalled();
    });

    it('진행 중 계약이 없어도 같은 번호 · 같은 이름의 가입 전 레코드가 있으면 다시 쓴다 (거부 · 만료 뒤 새 초안)', async () => {
      db.staffMember.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ staffMemberId: 4 });

      await service.create(dto({ isTemporarySave: true }), 1);

      expect(db.staffMember.findFirst.mock.calls[1][0]).toEqual({
        where: {
          storeId: 11,
          phone: '01090145563',
          name: '남도현',
          joinStatus: { not: 'JOINED' },
          // 퇴직(예정) 레코드는 다시 쓰지 않는다 — 다시 입사하면 새 레코드에 새 계약(2026-10-19 김민식)
          employmentStatus: 'EMPLOYED',
          retiredDate: null,
        },
        select: {
          staffMemberId: true,
          joinStatus: true,
          candidateAccountId: true,
        },
        orderBy: { staffMemberId: 'desc' },
      });
      expect(db.contract.create.mock.calls[0][0].data.staffMemberId).toBe(4);
      expect(db.staffMember.create).not.toHaveBeenCalled();
    });

    it('같은 번호라도 이름이 다르면(번호를 넘겨받은 다른 사람) 앞사람 레코드를 고치지 않고 새로 만든다', async () => {
      // 이름까지 맞는 레코드가 없다 — 두 번째 findFirst 도 null
      await service.create(dto({ name: '김새봄', isTemporarySave: true }), 1);

      expect(db.staffMember.findFirst.mock.calls[1][0].where).toMatchObject({
        name: '김새봄',
      });
      expect(db.staffMember.update).not.toHaveBeenCalled();
      expect(db.staffMember.create).toHaveBeenCalled();
    });

    it('이름이 달라 새 레코드를 만들어도, 대체로 계약을 잃은 옛 가입 전 레코드는 지운다', async () => {
      contractRows([
        {
          contractId: 5,
          status: 'DRAFT',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);

      await service.create(
        dto({ name: '김새봄', isTemporarySave: true, replaceContractIds: [5] }),
        1,
      );

      expect(db.staffMember.create).toHaveBeenCalled();
      expect(db.staffMember.deleteMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: { in: [2] },
          joinStatus: { not: 'JOINED' },
          contracts: { none: {} },
        },
      });
    });

    it('초안 저장은 다른 점포 근무 시간과 겹치면 409 로 막는다', async () => {
      contractRows([], [overlapping]);

      await expect(service.create(dto(), 1)).rejects.toMatchObject({
        response: { code: 'WORK_TIME_OVERLAP' },
      });
      expect(db.staffMember.create).not.toHaveBeenCalled();
    });

    it('임시저장은 다른 점포 근무 시간을 보지 않는다', async () => {
      contractRows([], [overlapping]);

      await expect(
        service.create(dto({ isTemporarySave: true }), 1),
      ).resolves.toEqual({ contractId: 7, staffMemberId: 3 });
      // 진행 중 계약 조회 한 번뿐이다
      expect(db.contract.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('이어 쓰기 (PUT)', () => {
    it('자기 자신은 빼고 같은 점포의 다른 진행 중 계약을 묻는다', async () => {
      contractRows([
        {
          contractId: 5,
          status: 'DRAFT',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);

      await expect(
        service.update(9, 7, dto({ isTemporarySave: true })),
      ).rejects.toMatchObject({ response: { code: 'CONTRACT_IN_PROGRESS' } });
      expect(db.contract.findMany.mock.calls[0][0].where).toMatchObject({
        contractId: { not: 7 },
      });
      expect(db.contract.updateMany).not.toHaveBeenCalled();
    });

    it('대체를 확인하면 기존 임시저장을 지우고, 계약이 남지 않은 그 레코드도 지운다', async () => {
      contractRows([
        {
          contractId: 5,
          status: 'DRAFT',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);

      await service.update(
        9,
        7,
        dto({ isTemporarySave: true, replaceContractIds: [5] }),
      );

      expect(db.contract.deleteMany).toHaveBeenCalledWith({
        where: { contractId: 5, status: 'DRAFT' },
      });
      expect(db.staffMember.deleteMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: { in: [2] },
          joinStatus: { not: 'JOINED' },
          contracts: { none: {} },
        },
      });
      expect(db.contract.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contractId: 7, status: 'DRAFT' },
        }) as unknown,
      );
    });

    it('지금 번호와 새 번호를 둘 다, 정한 순서(오름차순)로 잠근 뒤 계약 행을 잠근다', async () => {
      db.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        storeId: 11,
        staffMember: { phone: '01099998888' },
      });

      await service.update(
        9,
        7,
        dto({ phone: '01011112222', isTemporarySave: true }),
      );

      const locks = db.$executeRaw.mock.calls.map((c: unknown[]) =>
        (c as [TemplateStringsArray, ...unknown[]]).slice(1).join(','),
      );
      expect(locks.slice(0, 3)).toEqual([
        'contracts:01011112222',
        'contracts:01099998888',
        '7',
      ]);
    });

    it('잠그기 전에 읽은 번호가 잠근 뒤 바뀌었으면 409 — 다른 요청이 먼저 고쳤다', async () => {
      db.contract.findUnique
        // 범위 확인(트랜잭션 밖)
        .mockResolvedValueOnce({
          storeId: 11,
          staffMember: { isHqSharingConsented: false },
        })
        .mockResolvedValueOnce({ staffMember: { phone: '01090145563' } })
        .mockResolvedValueOnce({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01077776666' },
        });

      await expect(
        service.update(9, 7, dto({ isTemporarySave: true })),
      ).rejects.toThrow(
        '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
      );
      expect(db.contract.updateMany).not.toHaveBeenCalled();
    });

    it('초안 저장으로 넘길 때 다른 점포 근무 시간과 겹치면 409', async () => {
      contractRows([], [overlapping]);

      await expect(
        service.update(9, 7, dto({ isTemporarySave: false })),
      ).rejects.toMatchObject({ response: { code: 'WORK_TIME_OVERLAP' } });
      expect(db.contract.updateMany).not.toHaveBeenCalled();
    });
  });
});
