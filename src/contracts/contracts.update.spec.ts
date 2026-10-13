import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

describe('ContractsService 이어 쓰기 (findOne · update)', () => {
  let service: ContractsService;
  let tx: {
    contract: {
      findUnique: jest.Mock;
      updateMany: jest.Mock<
        Promise<{ count: number }>,
        [Prisma.ContractUpdateManyArgs]
      >;
    };
    account: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.AccountFindManyArgs]>;
    };
    staffMember: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>;
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>;
      update: jest.Mock<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>;
    };
    contractParty: {
      upsert: jest.Mock<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>;
    };
    contractWorkDay: {
      deleteMany: jest.Mock<
        Promise<unknown>,
        [Prisma.ContractWorkDayDeleteManyArgs]
      >;
      createMany: jest.Mock<
        Promise<unknown>,
        [Prisma.ContractWorkDayCreateManyArgs]
      >;
    };
    contractStatusHistory: {
      create: jest.Mock<
        Promise<unknown>,
        [Prisma.ContractStatusHistoryCreateArgs]
      >;
    };
  };
  let prisma: {
    $transaction: jest.Mock;
    contract: { findUnique: jest.Mock };
    store: { findFirst: jest.Mock; findUnique: jest.Mock };
  };

  const dto = (over: Partial<CreateContractDto> = {}): CreateContractDto => ({
    name: '남도현',
    phone: '01090145563',
    storeId: 11,
    jobTitle: '바리스타',
    employmentType: 'PART_TIME',
    contractMethod: 'ELECTRONIC',
    isTemporarySave: true,
    ...over,
  });

  beforeEach(async () => {
    tx = {
      contract: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'DRAFT', staffMemberId: 3 }),
        updateMany: jest
          .fn<Promise<{ count: number }>, [Prisma.ContractUpdateManyArgs]>()
          .mockResolvedValue({ count: 1 }),
      },
      account: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.AccountFindManyArgs]>()
          .mockResolvedValue([]),
      },
      staffMember: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>()
          .mockResolvedValue([]),
        findFirst: jest
          .fn<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>()
          .mockResolvedValue(null),
        update: jest.fn<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>(),
      },
      contractParty: {
        upsert: jest.fn<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>(),
      },
      contractWorkDay: {
        deleteMany: jest.fn<
          Promise<unknown>,
          [Prisma.ContractWorkDayDeleteManyArgs]
        >(),
        createMany: jest.fn<
          Promise<unknown>,
          [Prisma.ContractWorkDayCreateManyArgs]
        >(),
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
      contract: { findUnique: jest.fn() },
      store: {
        findFirst: jest.fn().mockResolvedValue({ storeId: 11 }),
        findUnique: jest.fn().mockResolvedValue({ name: '모리커피 성수점' }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  describe('findOne', () => {
    it('작성 화면을 다시 채울 값을 준다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        contractId: 7,
        staffMemberId: 3,
        storeId: 11,
        status: 'DRAFT',
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: new Date('2026-09-14T00:00:00Z'),
        endDate: null,
        workLocation: '서울 성동구 연무장길 18',
        weeklyHoliday: 'SUN',
        wageAmount: 11200,
        payMonth: 'NEXT_MONTH',
        payDay: 10,
        isHealthPensionInsured: null,
        isEmploymentInjuryInsured: true,
        draftAction: null,
        contractStatusHistories: [
          {
            fromStatus: null,
            toStatus: 'DRAFT',
            actor: 'ADMIN',
            changedAt: new Date('2026-10-12T01:00:00Z'),
          },
        ],
        staffMember: {
          name: '남도현',
          phone: '01090145563',
          jobTitle: '바리스타',
          employmentType: 'PART_TIME',
        },
        contractParty: { enteredBirthDate: new Date('1998-07-12T00:00:00Z') },
        contractWorkDays: [
          {
            weekday: 'TUE',
            startTime: new Date('1970-01-01T10:00:00Z'),
            endTime: new Date('1970-01-01T16:00:00Z'),
            breakStartTime: new Date('1970-01-01T12:00:00Z'),
            breakEndTime: new Date('1970-01-01T13:00:00Z'),
          },
          {
            weekday: 'THU',
            startTime: new Date('1970-01-01T10:00:00Z'),
            endTime: new Date('1970-01-01T14:30:00Z'),
            breakStartTime: null,
            breakEndTime: null,
          },
        ],
      });

      await expect(service.findOne(7)).resolves.toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'DRAFT',
        name: '남도현',
        phone: '01090145563',
        jobTitle: '바리스타',
        employmentType: 'PART_TIME',
        storeId: 11,
        storeName: '모리커피 성수점',
        birthDate: '1998-07-12',
        contractMethod: 'ELECTRONIC',
        startDate: '2026-09-14',
        endDate: null,
        workLocation: '서울 성동구 연무장길 18',
        weeklyHoliday: 'SUN',
        wageAmount: 11200,
        payMonth: 'NEXT_MONTH',
        payDay: 10,
        isHealthPensionInsured: null,
        isEmploymentInjuryInsured: true,
        draftAction: null,
        histories: [
          {
            fromStatus: null,
            toStatus: 'DRAFT',
            actor: 'ADMIN',
            changedAt: '2026-10-12T01:00:00.000Z',
          },
        ],
        workDays: [
          {
            weekday: 'TUE',
            startTime: '10:00',
            endTime: '16:00',
            breakStartTime: '12:00',
            breakEndTime: '13:00',
          },
          {
            weekday: 'THU',
            startTime: '10:00',
            endTime: '14:30',
            breakStartTime: null,
            breakEndTime: null,
          },
        ],
      });
      const [args] = prisma.contract.findUnique.mock.calls[0] as [
        Prisma.ContractFindUniqueArgs,
      ];
      expect(args.where).toEqual({ contractId: 7 });
      expect(args.select?.contractWorkDays).toMatchObject({
        orderBy: { weekday: 'asc' },
      });
      // 이력은 최근 것부터, 같은 시각이면 나중에 쓴 줄이 먼저
      expect(args.select?.contractStatusHistories).toMatchObject({
        orderBy: [{ changedAt: 'desc' }, { contractStatusHistoryId: 'desc' }],
      });
      expect(prisma.store.findUnique).toHaveBeenCalledWith({
        where: { storeId: 11 },
        select: { name: true },
      });
    });

    it('없으면 404', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await expect(service.findOne(7)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('임시저장을 그대로 고친다 — 직원 레코드 · 계약 · 당사자 · 근무 요일을 바꾸고 상태 이력은 남기지 않는다', async () => {
      await expect(
        service.update(
          7,
          dto({
            startDate: '2026-10-01',
            wageAmount: 11500,
            workLocation: '서울',
            workDays: [
              { weekday: 'MON', startTime: '09:00', endTime: '13:00' },
            ],
          }),
        ),
      ).resolves.toEqual({ contractId: 7, staffMemberId: 3 });

      const [upd] = tx.contract.updateMany.mock.calls[0];
      // 고치는 사이 상태가 바뀌었으면 아무것도 쓰지 않도록 조건에 상태를 건다.
      expect(upd.where).toEqual({ contractId: 7, status: 'DRAFT' });
      expect(upd.data).toMatchObject({
        storeId: 11,
        employmentType: 'PART_TIME',
        startDate: new Date('2026-10-01T00:00:00.000Z'),
        endDate: null,
        wageAmount: 11500,
        workLocation: '서울',
        payDay: null,
        status: 'DRAFT',
        draftAction: null,
      });
      expect(tx.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 3 },
        data: {
          storeId: 11,
          name: '남도현',
          phone: '01090145563',
          employmentType: 'PART_TIME',
          jobTitle: '바리스타',
          candidateAccountId: null,
        },
      });
      expect(tx.contractParty.upsert.mock.calls[0][0]).toMatchObject({
        where: { contractId: 7 },
        update: {
          enteredName: '남도현',
          enteredPhone: '01090145563',
          enteredBirthDate: null,
        },
      });
      expect(tx.contractWorkDay.deleteMany).toHaveBeenCalledWith({
        where: { contractId: 7 },
      });
      expect(tx.contractWorkDay.createMany.mock.calls[0][0].data).toEqual([
        {
          contractId: 7,
          weekday: 'MON',
          startTime: new Date('1970-01-01T09:00:00.000Z'),
          endTime: new Date('1970-01-01T13:00:00.000Z'),
          breakStartTime: null,
          breakEndTime: null,
        },
      ]);
      expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
    });

    it('임시저장으로 두면 초대 유형을 판별하지 않는다', async () => {
      await service.update(7, dto());
      expect(tx.account.findMany).not.toHaveBeenCalled();
    });

    it('초안 저장으로 넘기면 발송 대기가 되고 초대 유형을 판별해 남기며 이력을 남긴다', async () => {
      tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      await service.update(7, dto({ isTemporarySave: false }));
      expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'PENDING_SEND',
        draftAction: 'AFFILIATION_CONFIRM',
      });
      expect(tx.staffMember.update.mock.calls[0][0].data).toMatchObject({
        candidateAccountId: 42,
      });
      expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
        data: {
          contractId: 7,
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_SEND',
          actor: 'ADMIN',
        },
      });
    });

    it('근무 요일이 없으면 지우기만 한다', async () => {
      await service.update(7, dto());
      expect(tx.contractWorkDay.deleteMany).toHaveBeenCalled();
      expect(tx.contractWorkDay.createMany).not.toHaveBeenCalled();
    });

    it('없으면 404', async () => {
      tx.contract.findUnique.mockResolvedValue(null);
      await expect(service.update(7, dto())).rejects.toThrow(NotFoundException);
    });

    it('임시저장이 아니면 409 — 발송 대기 이후는 이 화면에서 고치지 않는다', async () => {
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        staffMemberId: 3,
      });
      await expect(service.update(7, dto())).rejects.toThrow(ConflictException);
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('읽은 뒤 상태가 바뀌어 조건부 갱신이 0건이면 409', async () => {
      tx.contract.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(7, dto())).rejects.toThrow(ConflictException);
      expect(tx.staffMember.update).not.toHaveBeenCalled();
    });

    it('같은 점포에 같은 번호로 재직 중인 다른 직원이 있으면 409 (자기 레코드는 빼고 본다)', async () => {
      tx.staffMember.findFirst.mockResolvedValue({ staffMemberId: 9 });
      await expect(service.update(7, dto())).rejects.toThrow(ConflictException);
      expect(tx.staffMember.findFirst.mock.calls[0][0].where).toEqual({
        storeId: 11,
        phone: '01090145563',
        employmentStatus: 'EMPLOYED',
        staffMemberId: { not: 3 },
      });
    });

    it('입력 검사는 저장과 같다 (만 19세 미만)', async () => {
      await expect(
        service.update(
          7,
          dto({ birthDate: '2010-01-01', startDate: '2026-10-01' }),
        ),
      ).rejects.toThrow('만 19세 미만');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
