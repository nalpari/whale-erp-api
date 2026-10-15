import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

describe('ContractsService 이어 쓰기 (findOne · update)', () => {
  let service: ContractsService;
  let tx: {
    $executeRaw: jest.Mock<
      Promise<number>,
      [TemplateStringsArray, string | number]
    >;
    contract: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
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
  let scope: { canManageStaffAt: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    contract: { findUnique: jest.Mock };
    contractDocument: { findMany: jest.Mock };
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
    scope = { canManageStaffAt: jest.fn().mockResolvedValue(true) };
    tx = {
      $executeRaw: jest
        .fn<Promise<number>, [TemplateStringsArray, string | number]>()
        .mockResolvedValue(1),
      contract: {
        // 잠그기 전 번호 읽기 · 잠근 뒤 다시 읽기가 같은 값을 받는다
        findUnique: jest.fn().mockResolvedValue({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        }),
        // 같은 점포 진행 중 계약 · 다른 점포 계약 — 기본은 없다
        findMany: jest.fn().mockResolvedValue([]),
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
      // 트랜잭션 밖 — 상세 조회와 이어 쓰기 전 범위 확인(근무지)이 쓴다
      contractDocument: { findMany: jest.fn().mockResolvedValue([]) },
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 11,
          staffMember: { isHqSharingConsented: false },
        }),
      },
      store: {
        findFirst: jest.fn().mockResolvedValue({ storeId: 11 }),
        findUnique: jest.fn().mockResolvedValue({ name: '모리커피 성수점' }),
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
        mealAllowanceAmount: 200000,
        carAllowanceAmount: null,
        childcareAllowanceAmount: null,
        baseHours: new Prisma.Decimal('60.5'),
        monthlyOvertimeHours: null,
        baseNightHours: null,
        baseHolidayHours: null,
        monthlyExtraHolidayHours: null,
        annualLeaveTerms: '근로기준법 제50조에 의거하여 연차휴가를 제공함',
        severancePayTerms: null,
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

      await expect(service.findOne(9, 7)).resolves.toEqual({
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
        mealAllowanceAmount: 200000,
        carAllowanceAmount: null,
        childcareAllowanceAmount: null,
        baseHours: 60.5, // Decimal 은 number 로 준다
        monthlyOvertimeHours: null,
        baseNightHours: null,
        baseHolidayHours: null,
        monthlyExtraHolidayHours: null,
        annualLeaveTerms: '근로기준법 제50조에 의거하여 연차휴가를 제공함',
        severancePayTerms: null,
        payMonth: 'NEXT_MONTH',
        payDay: 10,
        isHealthPensionInsured: null,
        isEmploymentInjuryInsured: true,
        documents: [],
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
      await expect(service.findOne(9, 7)).rejects.toThrow(NotFoundException);
    });

    it('계약 직원의 본사 제공 동의로 범위를 묻는다 — 동의한 가맹 점포 직원 계약은 본사 역할도 연다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { isHqSharingConsented: true },
      });
      scope.canManageStaffAt.mockResolvedValue(false);
      await expect(service.findOne(9, 7)).rejects.toThrow(NotFoundException);
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, true);
    });

    it('업무 범위 밖 점포의 계약은 없는 것과 같게 404', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { isHqSharingConsented: false },
      });
      scope.canManageStaffAt.mockResolvedValue(false);
      await expect(service.findOne(9, 7)).rejects.toThrow(
        '근로계약을 찾을 수 없습니다',
      );
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, false);
      expect(prisma.store.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('임시저장을 그대로 고친다 — 직원 레코드 · 계약 · 당사자 · 근무 요일을 바꾸고 상태 이력은 남기지 않는다', async () => {
      await expect(
        service.update(
          9,
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
      await service.update(9, 7, dto());
      expect(tx.account.findMany).not.toHaveBeenCalled();
    });

    it('초안 저장으로 넘기면 발송 대기가 되고 초대 유형을 판별해 남기며 이력을 남긴다', async () => {
      tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      await service.update(9, 7, dto({ isTemporarySave: false }));
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

    it('종이 계약으로 등록하면 임시저장에서 체결 완료가 되고 이력과 날인본을 남긴다', async () => {
      const storage = {
        put: jest
          .fn<Promise<void>, [string, Buffer, string]>()
          .mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      };
      const createMany = jest.fn().mockResolvedValue({ count: 1 });
      Object.assign(tx, { contractDocument: { createMany } });
      const module = await Test.createTestingModule({
        providers: [
          ContractsService,
          { provide: PrismaService, useValue: prisma },
          { provide: AdminScopeService, useValue: scope },
          { provide: STORAGE, useValue: storage },
        ],
      }).compile();
      await module
        .get(ContractsService)
        .update(
          9,
          7,
          dto({ isTemporarySave: false, contractMethod: 'PAPER' }),
          [
            {
              kind: 'PAPER_EMPLOYMENT_CONTRACT',
              fileName: '근로계약서.jpg',
              buffer: Buffer.from('jpg'),
              fileType: 'JPG',
            },
          ],
        );
      expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'SIGNED',
        contractMethod: 'PAPER',
      });
      expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
        data: {
          contractId: 7,
          fromStatus: 'DRAFT',
          toStatus: 'SIGNED',
          actor: 'ADMIN',
        },
      });
      expect(storage.put.mock.calls[0][0]).toMatch(/^contracts\/7\/.+\.jpg$/);
      expect(createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            contractId: 7,
            kind: 'PAPER_EMPLOYMENT_CONTRACT',
            fileName: '근로계약서.jpg',
          }),
        ],
      });
    });

    it('근무 요일이 없으면 지우기만 한다', async () => {
      await service.update(9, 7, dto());
      expect(tx.contractWorkDay.deleteMany).toHaveBeenCalled();
      expect(tx.contractWorkDay.createMany).not.toHaveBeenCalled();
    });

    it('없으면 404 — 범위를 보기 전에 트랜잭션을 열지 않는다', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('범위를 본 뒤 잠그기 전에 지워졌으면 404', async () => {
      tx.contract.findUnique.mockResolvedValue(null);
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('범위를 본 뒤 다른 요청이 근무지를 옮겼으면 409 — 옮긴 근무지의 범위는 보지 않았다', async () => {
      tx.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        storeId: 12,
        staffMember: { phone: '01090145563' },
      });
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        '다른 요청이 먼저 근무지를 고쳤습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('임시저장이 아니면 409 — 발송 대기 이후는 이 화면에서 고치지 않는다', async () => {
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        staffMemberId: 3,
        storeId: 11,
        staffMember: { phone: '01090145563' },
      });
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        ConflictException,
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('읽은 뒤 상태가 바뀌어 조건부 갱신이 0건이면 409', async () => {
      tx.contract.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        ConflictException,
      );
      expect(tx.staffMember.update).not.toHaveBeenCalled();
    });

    it('같은 점포에 같은 번호로 재직 중인 다른 직원이 있으면 409 (자기 레코드는 빼고 본다)', async () => {
      tx.staffMember.findFirst.mockResolvedValue({ staffMemberId: 9 });
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        ConflictException,
      );
      expect(tx.staffMember.findFirst.mock.calls[0][0].where).toEqual({
        storeId: 11,
        phone: '01090145563',
        joinStatus: 'JOINED',
        employmentStatus: 'EMPLOYED',
        staffMemberId: { not: 3 },
      });
    });

    it('업무 범위 밖 계약은 없는 것과 같게 404 — 아무것도 쓰지 않는다', async () => {
      scope.canManageStaffAt.mockResolvedValue(false);
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        '근로계약을 찾을 수 없습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('계약 직원의 동의로 범위를 묻고, 같은 근무지면 점포 단위로 다시 묻지 않는다 — 동의한 직원의 임시저장을 이어 쓴다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { isHqSharingConsented: true },
      });
      await service.update(9, 7, dto());
      expect(scope.canManageStaffAt.mock.calls).toEqual([[9, 11, true]]);
    });

    it('다른 근무지로 옮기면 그 점포는 점포 단위로 묻는다 — 새 근무지에는 아직 직원이 없다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { isHqSharingConsented: true },
      });
      await service.update(9, 7, dto({ storeId: 12 }));
      expect(scope.canManageStaffAt.mock.calls).toEqual([
        [9, 11, true],
        [9, 12, false],
      ]);
    });

    it('같은 근무지라도 그사이 폐점 · 삭제된 점포면 근무지 404 — 아무것도 쓰지 않는다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { isHqSharingConsented: true },
      });
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        '근무지 점포를 찾을 수 없습니다',
      );
      expect(prisma.store.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId: 11,
            isDeleted: false,
            storeStatusCode: { not: 'CLOSED' },
          },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('업무 범위 밖 점포로 옮기려 하면 근무지 404', async () => {
      scope.canManageStaffAt.mockImplementation((_: number, storeId: number) =>
        Promise.resolve(storeId === 11),
      );
      await expect(service.update(9, 7, dto({ storeId: 12 }))).rejects.toThrow(
        '근무지 점포를 찾을 수 없습니다',
      );
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('같은 번호로 잠그고 계약 행을 잠근 뒤 재직 확인 · 판별 · 쓰기를 한다', async () => {
      await service.update(9, 7, dto());
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      expect(tx.$executeRaw.mock.calls[0][1]).toBe('contracts:01090145563');
      // 사람 잠금 다음에 계약 행(FOR UPDATE) — 저장 · 대체와 같은 순서라 교착이 없다
      expect(tx.$executeRaw.mock.calls[1][1]).toBe(7);
      // 잠근 뒤 다시 읽는다(첫 읽기는 잠글 번호를 알려고 잠그기 전에 한다)
      expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.contract.findUnique.mock.invocationCallOrder[1],
      );
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.staffMember.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('입력 검사는 저장과 같다 (만 19세 미만)', async () => {
      await expect(
        service.update(
          9,
          7,
          dto({ birthDate: '2010-01-01', startDate: '2026-10-01' }),
        ),
      ).rejects.toThrow('만 19세 미만');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
