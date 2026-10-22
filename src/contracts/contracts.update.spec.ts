import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

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
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    staffMember: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>;
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>;
      update: jest.Mock<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>;
      updateMany: jest.Mock;
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
      // 근로계약 관리 메뉴 권한(WHALEERP-592) — 기본은 있다
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 7 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
          staffMember: {
            account: { isHqSharingConsented: false },
            phone: '01090145563',
          },
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
        { provide: ContractDeliveryService, useValue: delivery },
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
        // 이름 · 번호는 계약서(당사자) 값을 보인다 — 직원 레코드(가입했으면 계정 값)와 다를 수 있다
        contractParty: {
          enteredName: '남도연',
          enteredPhone: '01011112222',
          enteredBirthDate: new Date('1998-07-12T00:00:00Z'),
          enteredGender: 'FEMALE',
          isForeigner: true,
        },
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
        name: '남도연',
        phone: '01011112222',
        jobTitle: '바리스타',
        employmentType: 'PART_TIME',
        storeId: 11,
        storeName: '모리커피 성수점',
        birthDate: '1998-07-12',
        gender: 'FEMALE',
        isForeigner: true,
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
      // 직원 필기 서명은 처리 완료본(131)의 재료라 관리자 상세에 싣지 않는다(WHALEERP-145)
      expect(prisma.contractDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contractId: 7, kind: { not: 'SIGNATURE' } },
        }),
      );
    });

    it('없으면 404', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await expect(service.findOne(9, 7)).rejects.toThrow(NotFoundException);
    });

    it('계약 직원의 본사 제공 동의로 범위를 묻는다 — 동의한 가맹 점포 직원 계약은 본사 역할도 연다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: {
          account: { isHqSharingConsented: true },
          phone: '01090145563',
        },
      });
      scope.canManageStaffAt.mockResolvedValue(false);
      await expect(service.findOne(9, 7)).rejects.toThrow(NotFoundException);
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(9, 11, true);
    });

    it('업무 범위 밖 점포의 계약은 없는 것과 같게 404', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: {
          account: { isHqSharingConsented: false },
          phone: '01090145563',
        },
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

    it('초안 저장으로 넘기면 곧바로 보낸다 — 계정이 있는 번호면 서명 대기, 초대 유형 · 이력을 남기고 커밋 뒤 보낸다', async () => {
      tx.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      await service.update(9, 7, dto({ isTemporarySave: false }));
      expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'PENDING_SIGNATURE',
        draftAction: 'AFFILIATION_CONFIRM',
      });
      expect(tx.staffMember.update.mock.calls[0][0].data).toMatchObject({
        candidateAccountId: 42,
      });
      expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
        data: {
          contractId: 7,
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_SIGNATURE',
          actor: 'ADMIN',
        },
      });
      expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
        contractId: 7,
        phone: '01090145563',
        joined: false,
        draftAction: 'AFFILIATION_CONFIRM',
        statusChanged: true,
        phoneChanged: false,
        before: { status: 'DRAFT', staffMemberId: 3 },
      });
      expect(delivery.dispatch).toHaveBeenCalledWith(null, 9);
    });

    it('계정이 없는 번호면 가입 초대 — 발송 대기로 넘긴다', async () => {
      await service.update(9, 7, dto({ isTemporarySave: false }));
      expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'PENDING_SEND',
        draftAction: 'SIGNUP_INVITE',
      });
      expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
        draftAction: 'SIGNUP_INVITE',
      });
    });

    /** 역할 그룹이 가진 근로계약 관리 동작 — count 의 OR 조건에 그 동작 열이 있으면 1 */
    const allowOnly = (
      ...columns: ('isCreatable' | 'isUpdatable' | 'isDeletable')[]
    ) =>
      tx.roleGroupMenu.count.mockImplementation(
        ({ where }: { where: { OR: Record<string, boolean>[] } }) =>
          Promise.resolve(
            where.OR.some((o) => columns.some((c) => o[c])) ? 1 : 0,
          ),
      );

    it('임시저장을 이어 써 보내는 것은 작성 권한이다 — 수정 권한만 있으면 403, 쓰지 않는다(WHALEERP-592)', async () => {
      allowOnly('isUpdatable');
      await expect(
        service.update(9, 7, dto({ isTemporarySave: false })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
      expect(delivery.prepare).not.toHaveBeenCalled();
    });

    it('수정 요청 계약서를 고쳐 다시 보내는 것은 수정 권한이다 — 작성 권한만 있으면 403(WHALEERP-592)', async () => {
      allowOnly('isCreatable');
      tx.contract.findUnique.mockResolvedValue({
        status: 'CORRECTION_REQUESTED',
        staffMemberId: 3,
        storeId: 11,
        draftAction: 'SIGNUP_INVITE',
        staffMember: {
          phone: '01090145563',
          joinStatus: 'INVITED',
          candidateAccountId: null,
        },
      });
      await expect(
        service.update(9, 7, dto({ isTemporarySave: false })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('대체할 계약에 임시저장이 있으면 삭제 권한도 있어야 한다 — 작성 · 수정 권한만이면 403, 지우지 않는다(api #97 리뷰)', async () => {
      allowOnly('isCreatable', 'isUpdatable');
      tx.contract.findMany.mockResolvedValueOnce([
        {
          contractId: 5,
          status: 'DRAFT',
          staffMemberId: 3,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);
      await expect(
        service.update(9, 7, dto({ replaceContractIds: [5] })),
      ).rejects.toThrow('삭제 권한');
      expect(tx.contractWorkDay.deleteMany).not.toHaveBeenCalled();
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('수정 권한이 없으면 대체를 묻기(409) 전에 403 — 기존 계약의 이름을 보이지 않는다', async () => {
      allowOnly('isCreatable');
      tx.contract.findMany.mockResolvedValueOnce([
        {
          contractId: 5,
          status: 'PENDING_SEND',
          staffMemberId: 3,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);
      const error = await service.update(9, 7, dto()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toContain('수정 권한');
      expect(
        JSON.stringify((error as ForbiddenException).getResponse()),
      ).not.toContain('남도현');
    });

    it('임시저장은 보내지 않는다', async () => {
      await service.update(9, 7, dto());
      expect(delivery.prepare).not.toHaveBeenCalled();
      expect(delivery.dispatch).toHaveBeenCalledWith(null, 9);
    });

    // 본인 대조(WHALEERP-125 · 126) — 직원이 수정을 요청한 계약도 고친다. 고치면 발송 대기로 돌아가 다시 보낸다
    describe('수정 요청 계약', () => {
      const correction = (joinStatus = 'INVITED') => ({
        status: 'CORRECTION_REQUESTED',
        staffMemberId: 3,
        storeId: 11,
        draftAction: 'SIGNUP_INVITE',
        staffMember: {
          phone: '01090145563',
          joinStatus,
          candidateAccountId: null,
        },
      });
      beforeEach(() => tx.contract.findUnique.mockResolvedValue(correction()));

      it('가입한 직원의 수정 요청을 고쳐 저장하면 곧바로 서명 대기로 다시 보낸다 — 발송 대기를 거치지 않는다(2026-10-19 재영)', async () => {
        tx.contract.findUnique.mockResolvedValue(correction('JOINED'));
        await service.update(9, 7, dto({ isTemporarySave: false }));
        expect(tx.contract.updateMany.mock.calls[0][0]).toMatchObject({
          where: { contractId: 7, status: 'CORRECTION_REQUESTED' },
          data: { status: 'PENDING_SIGNATURE' },
        });
        expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
          data: {
            contractId: 7,
            fromStatus: 'CORRECTION_REQUESTED',
            toStatus: 'PENDING_SIGNATURE',
            actor: 'ADMIN',
          },
        });
        expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
          joined: true,
          statusChanged: true,
          before: { status: 'CORRECTION_REQUESTED' },
        });
      });

      it('가입 전 직원이고 가입 초대였으면 가입 초대를 다시 보내 발송 대기로', async () => {
        await service.update(9, 7, dto({ isTemporarySave: false }));
        expect(tx.contract.updateMany.mock.calls[0][0]).toMatchObject({
          data: { status: 'PENDING_SEND' },
        });
      });

      it('초대 유형을 다시 판별하지 않고 보낸 때의 값을 그대로 둔다', async () => {
        await service.update(9, 7, dto({ isTemporarySave: false }));
        expect(tx.account.findMany).not.toHaveBeenCalled();
        expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
          draftAction: 'SIGNUP_INVITE',
        });
      });

      it('가입 전 직원의 번호를 바꾸면 새 번호로 초대 유형을 다시 판별한다 — 옛 번호의 후보 계정을 남기지 않는다', async () => {
        tx.contract.findUnique.mockResolvedValue({
          ...correction(),
          draftAction: 'AFFILIATION_CONFIRM',
          staffMember: {
            phone: '01090145563',
            joinStatus: 'INVITED',
            candidateAccountId: 41,
          },
        });
        tx.account.findMany.mockResolvedValue([]);
        await service.update(
          9,
          7,
          dto({ isTemporarySave: false, phone: '01011112222' }),
        );
        expect(tx.account.findMany.mock.calls[0][0].where).toMatchObject({
          phone: '01011112222',
        });
        expect(tx.contract.updateMany.mock.calls[0][0].data).toMatchObject({
          draftAction: 'SIGNUP_INVITE',
        });
        expect(tx.staffMember.update.mock.calls[0][0].data).toMatchObject({
          phone: '01011112222',
          candidateAccountId: null,
        });
      });

      it('가입한 직원이면 직원 레코드의 이름 · 번호 · 생년월일은 두고 직무 · 고용 형태만 고친다', async () => {
        tx.contract.findUnique.mockResolvedValue(correction('JOINED'));
        await service.update(
          9,
          7,
          dto({ isTemporarySave: false, name: '남도연' }),
        );
        expect(tx.staffMember.update).toHaveBeenCalledWith({
          where: { staffMemberId: 3 },
          data: { employmentType: 'PART_TIME', jobTitle: '바리스타' },
        });
        expect(tx.contractParty.upsert).toHaveBeenCalled();
      });

      it('가입한 직원의 번호를 바꾸면 400 — 쓰지 않는다', async () => {
        tx.contract.findUnique.mockResolvedValue(correction('JOINED'));
        await expect(
          service.update(
            9,
            7,
            dto({ isTemporarySave: false, phone: '01011112222' }),
          ),
        ).rejects.toThrow('가입한 직원의 휴대전화번호는 바꿀 수 없습니다');
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      });

      it('근무지를 바꾸면 400 — 다른 근무지는 새 근로계약서로 쓴다', async () => {
        await expect(
          service.update(9, 7, dto({ isTemporarySave: false, storeId: 12 })),
        ).rejects.toThrow('수정 요청 근로계약서는 근무지를 바꿀 수 없습니다');
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      });

      it('임시저장은 400 — 수정 요청을 임시저장으로 되돌리지 않는다', async () => {
        await expect(service.update(9, 7, dto())).rejects.toThrow(
          '임시저장 · 종이 계약 등록은 할 수 없습니다',
        );
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      });
    });

    it.each(['PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'])(
      '%s 이면 이어 쓰기는 409 — 임시저장 · 수정 요청만 고친다',
      async (status) => {
        tx.contract.findUnique.mockResolvedValue({
          status,
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        });
        await expect(
          service.update(9, 7, dto({ isTemporarySave: false })),
        ).rejects.toThrow('임시저장 · 수정 요청 근로계약서만 고칠 수 있습니다');
      },
    );

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
          { provide: ContractDeliveryService, useValue: delivery },
        ],
      }).compile();
      await module.get(ContractsService).update(
        9,
        7,
        dto({
          isTemporarySave: false,
          contractMethod: 'PAPER',
          startDate: '2026-09-14',
        }),
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
      // 체결 완료라 입사일이 비어 있으면 계약 시작일로(WHALEERP-613)
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 3, hiredDate: null },
        data: { hiredDate: new Date('2026-09-14T00:00:00.000Z') },
      });
    });

    it('임시저장 · 보냄(발송)은 입사일을 건드리지 않는다', async () => {
      await service.update(9, 7, dto());
      await service.update(9, 7, dto({ isTemporarySave: false }));
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
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

    it('계약 직원의 동의로 범위를 묻고, 같은 근무지면 점포 단위 범위가 없어도 이어 쓴다 — 동의한 직원의 임시저장', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: {
          account: { isHqSharingConsented: true },
          phone: '01090145563',
        },
      });
      // 동의로만 보이는 관리자(본사 역할) — 점포 단위 범위는 묻기만 하고 요구하지 않는다
      scope.canManageStaffAt.mockImplementation(
        (_: number, __: number, consented: boolean) =>
          Promise.resolve(consented),
      );
      await service.update(9, 7, dto());
      expect(scope.canManageStaffAt.mock.calls).toEqual([
        [9, 11, true],
        [9, 11, false],
      ]);
      expect(tx.contract.updateMany).toHaveBeenCalled();
    });

    it('다른 근무지로 옮기면 그 점포는 점포 단위로 묻는다 — 새 근무지에는 아직 직원이 없다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: {
          account: { isHqSharingConsented: true },
          phone: '01090145563',
        },
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
        staffMember: {
          account: { isHqSharingConsented: true },
          phone: '01090145563',
        },
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

    // api #49 4차 리뷰 — 동의로만 보이는 관리자가 번호를 바꿔 보내 남의 계약을 409 로 엿보거나 대체로 닫지 못하게
    // api #49 5차 리뷰 참고 1 — 번호를 그대로 둬도 같은 점포 · 같은 번호의 다른 직원 레코드 계약이 대체 후보로 잡힌다
    describe('동의로만 보는 관리자는 다른 직원 레코드의 계약을 보거나 대체하지 못한다', () => {
      const other = {
        contractId: 5,
        status: 'SIGNED',
        staffMemberId: 8,
        startDate: null,
        endDate: null,
        staffMember: { name: '다른사람' },
      };
      beforeEach(() =>
        prisma.contract.findUnique.mockResolvedValue({
          storeId: 11,
          staffMember: {
            account: { isHqSharingConsented: true },
            phone: '01090145563',
          },
        }),
      );

      it('다른 레코드 계약이 섞이면 403 — 409 로 이름을 보이지 않고 대체도 하지 않는다', async () => {
        scope.canManageStaffAt.mockImplementation(
          (_: number, __: number, consented: boolean) =>
            Promise.resolve(consented),
        );
        tx.contract.findMany.mockResolvedValueOnce([other]);
        const error = await service
          .update(9, 7, dto({ replaceContractIds: [5] }))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(
          JSON.stringify((error as ForbiddenException).getResponse()),
        ).not.toContain('다른사람');
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      });

      it('자기 레코드의 계약만이면 지금처럼 409 로 대체를 묻는다', async () => {
        scope.canManageStaffAt.mockImplementation(
          (_: number, __: number, consented: boolean) =>
            Promise.resolve(consented),
        );
        tx.contract.findMany.mockResolvedValueOnce([
          { ...other, status: 'PENDING_SEND', staffMemberId: 3 },
        ]);
        await expect(service.update(9, 7, dto())).rejects.toThrow(
          ConflictException,
        );
      });

      it('점포 단위 범위가 있으면 다른 레코드 계약도 409 로 묻는다', async () => {
        tx.contract.findMany.mockResolvedValueOnce([other]);
        const error = await service
          .update(9, 7, dto())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
      });
    });

    describe('번호 바꾸기는 점포 단위 범위가 있어야 한다', () => {
      beforeEach(() =>
        prisma.contract.findUnique.mockResolvedValue({
          storeId: 11,
          staffMember: {
            account: { isHqSharingConsented: true },
            phone: '01090145563',
          },
        }),
      );

      it('동의로만 보이는 관리자가 번호를 바꾸면 403 — 같은 점포 계약을 묻지도 쓰지도 않는다', async () => {
        scope.canManageStaffAt.mockImplementation(
          (_: number, __: number, consented: boolean) =>
            Promise.resolve(consented),
        );
        await expect(
          service.update(9, 7, dto({ phone: '01011112222' })),
        ).rejects.toThrow(ForbiddenException);
        expect(scope.canManageStaffAt.mock.calls).toEqual([
          [9, 11, true],
          [9, 11, false],
        ]);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.contract.findMany).not.toHaveBeenCalled();
      });

      it('점포 단위 범위가 있으면 번호를 바꿔 이어 쓴다', async () => {
        await service.update(9, 7, dto({ phone: '01011112222' }));
        expect(scope.canManageStaffAt.mock.calls).toEqual([
          [9, 11, true],
          [9, 11, false],
        ]);
        expect(tx.contract.updateMany).toHaveBeenCalled();
      });

      it('범위를 본 뒤 다른 요청이 번호를 바꿨으면 409 — 번호 검사가 맞지 않는다', async () => {
        tx.contract.findUnique.mockResolvedValueOnce({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01099998888' },
        });
        await expect(service.update(9, 7, dto())).rejects.toThrow(
          '다른 요청이 먼저 근로계약을 고쳤습니다',
        );
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      });
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

    it('같은 번호 → 직원 행 → 계약 행을 잠근 뒤 재직 확인 · 판별 · 쓰기를 한다', async () => {
      await service.update(9, 7, dto());
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expect(tx.$executeRaw.mock.calls[0][1]).toBe('contracts:01090145563');
      // 사람 잠금 다음에 직원 행(FOR NO KEY UPDATE), 그다음 계약 행(FOR UPDATE) — 퇴직 확정 · 직원 앱 날인과 같은 순서라 교착이 없다(api #104)
      expect(tx.$executeRaw.mock.calls[1][0].join('?')).toMatch(
        /FROM staff_members .* FOR NO KEY UPDATE$/,
      );
      expect(tx.$executeRaw.mock.calls[1][1]).toBe(3);
      expect(tx.$executeRaw.mock.calls[2][1]).toBe(7);
      // 잠근 뒤 다시 읽는다(첫 읽기는 잠글 번호 · 직원을 알려고 잠그기 전에 한다)
      expect(tx.$executeRaw.mock.invocationCallOrder[2]).toBeLessThan(
        tx.contract.findUnique.mock.invocationCallOrder[1],
      );
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.staffMember.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('잠근 뒤 다시 읽은 계약의 직원이 잠근 직원과 다르면 409 — 잠그지 않은 직원 행을 쓰지 않는다', async () => {
      tx.contract.findUnique
        .mockResolvedValueOnce({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        })
        .mockResolvedValueOnce({
          status: 'DRAFT',
          staffMemberId: 4,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        });
      await expect(service.update(9, 7, dto())).rejects.toThrow(
        '다른 요청이 먼저 근로계약을 고쳤습니다',
      );
      expect(tx.staffMember.update).not.toHaveBeenCalled();
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
