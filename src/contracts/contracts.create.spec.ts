import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractFilesService } from './contract-files.service';
import { ContractsService, type PaperDocument } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

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

describe('ContractsService.create', () => {
  let service: ContractsService;
  let scope: { canManageStaffAt: jest.Mock };
  // 트랜잭션 안의 쿼리도 같은 객체로 받는다($transaction 이 자기를 넘긴다).
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock<Promise<number>, [TemplateStringsArray, string]>;
    store: {
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StoreFindFirstArgs]>;
    };
    account: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.AccountFindManyArgs]>;
    };
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    staffMember: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>;
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>;
      create: jest.Mock<Promise<unknown>, [Prisma.StaffMemberCreateArgs]>;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    // 중복 검사(contract-duplicates) — 기본은 진행 중 계약 · 다른 점포 계약이 없다
    contract: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    contractDocument: { createMany: jest.Mock; findFirst: jest.Mock };
  };
  let storage: {
    put: jest.Mock<Promise<void>, [string, Buffer, string]>;
    delete: jest.Mock<Promise<void>, [string]>;
  };

  const dto = (over: Partial<CreateContractDto> = {}): CreateContractDto => ({
    name: '남도현',
    phone: '01090145563',
    birthDate: '1998-07-12',
    gender: 'MALE',
    isForeigner: true,
    storeId: 11,
    jobTitle: '바리스타',
    employmentType: 'FULL_TIME',
    contractMethod: 'ELECTRONIC',
    startDate: '2026-09-14',
    wageAmount: 12000,
    workDays: [
      {
        weekday: 'MON',
        startTime: '09:00',
        endTime: '18:00',
        breakStartTime: '12:00',
        breakEndTime: '13:00',
      },
      { weekday: 'TUE', startTime: '09:00', endTime: '13:00' },
    ],
    payMonth: 'NEXT_MONTH',
    payDay: 10,
    payMethod: 'ACCOUNT',
    isHealthPensionInsured: true,
    isEmploymentInjuryInsured: false,
    ...over,
  });

  beforeEach(async () => {
    scope = { canManageStaffAt: jest.fn().mockResolvedValue(true) };
    prisma = {
      $transaction: jest.fn((work: (t: typeof prisma) => Promise<unknown>) =>
        work(prisma),
      ),
      // 재입사 사슬 조회(linkedRecords) — 기본은 이은 레코드가 없다
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest
        .fn<Promise<number>, [TemplateStringsArray, string]>()
        .mockResolvedValue(1),
      store: {
        findFirst: jest
          .fn<Promise<unknown>, [Prisma.StoreFindFirstArgs]>()
          .mockResolvedValue({ storeId: 11 }),
      },
      account: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.AccountFindManyArgs]>()
          .mockResolvedValue([]),
      },
      // 근로계약 관리 메뉴 권한(WHALEERP-592) — 기본은 있다
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 7 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      staffMember: {
        findMany: jest
          .fn<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>()
          .mockResolvedValue([]),
        findFirst: jest
          .fn<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>()
          .mockResolvedValue(null),
        create: jest
          .fn<Promise<unknown>, [Prisma.StaffMemberCreateArgs]>()
          .mockResolvedValue({
            staffMemberId: 3,
            contracts: [{ contractId: 7 }],
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      contract: {
        findMany: jest.fn().mockResolvedValue([]),
        // 같은 점포 가입 재직 직원의 최근 체결 계약(자동 재계약) — 없다
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ contractId: 8 }),
      },
      contractDocument: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
      },
    };
    storage = {
      put: jest
        .fn<Promise<void>, [string, Buffer, string]>()
        .mockResolvedValue(undefined),
      delete: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: storage },
        { provide: ContractDeliveryService, useValue: delivery },
        { provide: ContractFilesService, useValue: { afterSent: jest.fn() } },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  const created = () => prisma.staffMember.create.mock.calls[0][0].data;

  it('직원 레코드(초안)와 발송 대기 계약 · 당사자 · 근무 요일 · 상태 이력을 한 번에 만든다', async () => {
    await expect(service.create(dto(), 1)).resolves.toEqual({
      contractId: 7,
      staffMemberId: 3,
      status: 'PENDING_SEND',
      draftAction: 'SIGNUP_INVITE',
    });

    expect(prisma.staffMember.create).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({
      storeId: 11,
      name: '남도현',
      phone: '01090145563',
      employmentType: 'FULL_TIME',
      jobTitle: '바리스타',
      joinStatus: 'DRAFT',
      candidateAccountId: null,
      // 퇴직한 같은 사람의 레코드가 없다(WHALEERP-615)
      previousStaffMemberId: null,
      contracts: {
        create: {
          storeId: 11,
          employmentType: 'FULL_TIME',
          // 계약서에 적은 직무(WHALEERP-156)
          jobTitle: '바리스타',
          contractMethod: 'ELECTRONIC',
          startDate: new Date('2026-09-14T00:00:00.000Z'),
          endDate: null,
          workLocation: null,
          weeklyHoliday: null,
          wageAmount: 12000,
          // api #12 칸 — 보내지 않으면 비운다
          mealAllowanceAmount: null,
          carAllowanceAmount: null,
          childcareAllowanceAmount: null,
          baseHours: null,
          monthlyOvertimeHours: null,
          baseNightHours: null,
          baseHolidayHours: null,
          monthlyExtraHolidayHours: null,
          annualLeaveTerms: null,
          severancePayTerms: null,
          payMonth: 'NEXT_MONTH',
          payDay: 10,
          payMethod: 'ACCOUNT',
          probationMonths: null,
          probationWageReductionRate: null,
          isHealthPensionInsured: true,
          isEmploymentInjuryInsured: false,
          status: 'PENDING_SEND',
          draftAction: 'SIGNUP_INVITE',
          // 재계약이 아니다(WHALEERP-156)
          previousContractId: null,
          createdBy: 1,
          contractParty: {
            create: {
              enteredName: '남도현',
              enteredPhone: '01090145563',
              enteredBirthDate: new Date('1998-07-12T00:00:00.000Z'),
              // 본인 대조에 쓰는 성별 · 외국인 여부(WHALEERP-125)
              enteredGender: 'MALE',
              isForeigner: true,
            },
          },
          contractWorkDays: {
            create: [
              {
                weekday: 'MON',
                startTime: new Date('1970-01-01T09:00:00.000Z'),
                endTime: new Date('1970-01-01T18:00:00.000Z'),
                breakStartTime: new Date('1970-01-01T12:00:00.000Z'),
                breakEndTime: new Date('1970-01-01T13:00:00.000Z'),
              },
              {
                weekday: 'TUE',
                startTime: new Date('1970-01-01T09:00:00.000Z'),
                endTime: new Date('1970-01-01T13:00:00.000Z'),
                breakStartTime: null,
                breakEndTime: null,
              },
            ],
          },
          contractStatusHistories: {
            create: { toStatus: 'PENDING_SEND', actor: 'ADMIN' },
          },
        },
      },
    });
  });

  // 저장하면 곧바로 보낸다(2026-10-19 재영) — 계정이 없는 번호는 가입 초대(발송 대기, 위), 있으면 서명 대기
  it('초안 저장은 곧바로 보낸다 — 새 계약이라 되돌리면 임시저장인 보내기 직전 값을 넘기고, 커밋 뒤 보낸다', async () => {
    const pending = { invitationId: 50 };
    delivery.prepare.mockResolvedValue(pending);
    await service.create(dto(), 1);
    expect(delivery.prepare).toHaveBeenCalledWith(
      prisma,
      {
        contractId: 7,
        storeId: 11,
        phone: '01090145563',
        joined: false,
        draftAction: 'SIGNUP_INVITE',
        before: {
          status: null,
          sentAt: null,
          signDeadlineAt: null,
          draftAction: null,
          staffMemberId: 3,
          staffMember: { joinStatus: 'DRAFT', candidateAccountId: null },
        },
        statusChanged: true,
        phoneChanged: false,
        replacedContracts: false,
      },
      expect.any(Date),
    );
    expect(delivery.dispatch).toHaveBeenCalledWith(pending, 1);
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.dispatch.mock.invocationCallOrder[0],
    );
  });

  it('그 번호로 계정이 있으면 발송 대기로 만들고 소속 추가 확인 요청을 보낸다 — 수락하면 서명 대기(WHALEERP-130, 2026-10-26 재영)', async () => {
    prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
    await service.create(dto(), 1);
    expect(created().contracts).toMatchObject({
      create: {
        status: 'PENDING_SEND',
        draftAction: 'AFFILIATION_CONFIRM',
        contractStatusHistories: {
          create: { toStatus: 'PENDING_SEND', actor: 'ADMIN' },
        },
      },
    });
    expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
      draftAction: 'AFFILIATION_CONFIRM',
    });
  });

  // 임시저장은 초대 · 계약서를 보내지 않는 저장이다. 상태와 첫 이력만 다르다.
  it('임시저장이면 임시저장(DRAFT) 상태와 이력으로 만든다 — 보내지 않는다', async () => {
    await service.create(dto({ isTemporarySave: true }), 1);
    expect(created().contracts).toMatchObject({
      create: {
        status: 'DRAFT',
        contractStatusHistories: {
          create: { toStatus: 'DRAFT', actor: 'ADMIN' },
        },
      },
    });
    expect(delivery.prepare).not.toHaveBeenCalled();
  });

  it('근무 장소를 넣는다. 없으면 비운다', async () => {
    await service.create(
      dto({ workLocation: '서울 성동구 연무장길 18, 1층' }),
      1,
    );
    expect(created().contracts).toMatchObject({
      create: { workLocation: '서울 성동구 연무장길 18, 1층' },
    });
    prisma.staffMember.create.mockClear();
    await service.create(dto(), 1);
    expect(created().contracts).toMatchObject({
      create: { workLocation: null },
    });
  });

  // 근로계약은 키만 NOT NULL 이다. 직원 레코드 칸(이름 · 번호 · 직무 · 고용 형태)과 근무지만 있으면 임시저장된다.
  it('임시저장은 계약 칸을 비워도 저장한다', async () => {
    const partial: CreateContractDto = {
      name: '남도현',
      phone: '01090145563',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'PART_TIME',
      contractMethod: 'ELECTRONIC',
      isTemporarySave: true,
    };
    await expect(service.create(partial, 1)).resolves.toBeDefined();
    expect(created().contracts).toMatchObject({
      create: {
        status: 'DRAFT',
        startDate: null,
        endDate: null,
        wageAmount: null,
        weeklyHoliday: null,
        payMonth: null,
        payDay: null,
        isHealthPensionInsured: null,
        isEmploymentInjuryInsured: null,
        contractParty: { create: { enteredBirthDate: null } },
        contractWorkDays: { create: [] },
      },
    });
  });

  it('임시저장이어도 넣은 값은 검사한다 (만 19세 미만)', async () => {
    await expect(
      service.create(
        dto({ isTemporarySave: true, birthDate: '2010-01-01' }),
        1,
      ),
    ).rejects.toThrow('만 19세 미만');
  });

  // 초대 유형 판별 (목업 contracts-new). 발송은 아직 없어 판별만 남긴다 — invitations 행 · 토큰 · INVITED 는 발송 때.
  describe('초대 유형 판별', () => {
    it('같은 번호의 계정은 탈퇴하지 않은 것 중 가장 최근 것 하나를 본다', async () => {
      await service.create(dto(), 1);
      expect(prisma.account.findMany).toHaveBeenCalledWith({
        where: { phone: '01090145563', status: { not: 'WITHDRAWN' } },
        select: { accountId: true },
        orderBy: [{ createdAt: 'desc' }, { accountId: 'desc' }],
        take: 1,
      });
    });

    it('계정이 있고 이 점포에 그 계정의 레코드가 없으면 소속 추가 확인, 그 계정이 후보다', async () => {
      prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      await service.create(dto(), 1);
      expect(prisma.staffMember.findMany).toHaveBeenCalledWith({
        where: { storeId: 11, accountId: 42 },
        select: { employmentStatus: true },
      });
      expect(created()).toMatchObject({
        joinStatus: 'DRAFT',
        candidateAccountId: 42,
        contracts: { create: { draftAction: 'AFFILIATION_CONFIRM' } },
      });
    });

    it('이 점포에 그 계정의 퇴직 레코드가 있으면 복귀 확인', async () => {
      prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      prisma.staffMember.findMany.mockResolvedValue([
        { employmentStatus: 'RETIRED' },
      ]);
      await service.create(dto(), 1);
      expect(created()).toMatchObject({
        candidateAccountId: 42,
        contracts: { create: { draftAction: 'RETURN_CONFIRM' } },
      });
    });

    it('이 점포에 그 계정이 재직 중이면 409 (번호가 달라도)', async () => {
      prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      prisma.staffMember.findMany.mockResolvedValue([
        { employmentStatus: 'RETIRED' },
        { employmentStatus: 'EMPLOYED' },
      ]);
      await expect(service.create(dto(), 1)).rejects.toThrow(ConflictException);
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

    it('임시저장은 판별하지 않는다', async () => {
      await service.create(dto({ isTemporarySave: true }), 1);
      // 계정 조회는 재입사 레코드를 잇는 한 번뿐이다(WHALEERP-615) — 판별하면 한 번 더 조회한다
      expect(prisma.account.findMany).toHaveBeenCalledTimes(1);
      expect(created()).toMatchObject({
        candidateAccountId: null,
        contracts: { create: { status: 'DRAFT', draftAction: null } },
      });
    });
  });

  type WorkDay = NonNullable<CreateContractDto['workDays']>[number];
  const day = (
    weekday: WorkDay['weekday'],
    startTime: string,
    endTime: string,
    rest = false,
  ): WorkDay => ({
    weekday,
    startTime,
    endTime,
    ...(rest ? { breakStartTime: '12:00', breakEndTime: '13:00' } : {}),
  });
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

  // 주휴일은 관리자가 근무하지 않는 요일 하나를 고른다(노무사 확인 2026-10-14). 주 15시간 미만이면 없다.
  describe('주휴일', () => {
    const fullWeek = weekdays
      .slice(0, 5)
      .map((w) => day(w, '09:00', '18:00', true));

    it('주 15시간 이상이면 고른 요일을 저장한다', async () => {
      await service.create(
        dto({ workDays: fullWeek, weeklyHoliday: 'SUN' }),
        1,
      );
      expect(created().contracts).toMatchObject({
        create: { weeklyHoliday: 'SUN' },
      });
    });

    it('주 15시간 이상인데 고르지 않으면 400', async () => {
      await expect(
        service.create(dto({ workDays: fullWeek }), 1),
      ).rejects.toThrow('주휴일을 골라야');
    });

    it('임시저장이면 고르지 않아도 저장한다', async () => {
      await service.create(
        dto({ workDays: fullWeek, isTemporarySave: true }),
        1,
      );
      expect(created().contracts).toMatchObject({
        create: { weeklyHoliday: null },
      });
    });

    it('근무하는 요일을 고르면 400', async () => {
      await expect(
        service.create(dto({ workDays: fullWeek, weeklyHoliday: 'MON' }), 1),
      ).rejects.toThrow('근무하지 않는 요일');
    });

    it('정확히 주 15시간이면 골라야 한다', async () => {
      const workDays = [
        day('MON', '09:00', '16:30'),
        day('TUE', '09:00', '16:30'),
      ];
      await expect(service.create(dto({ workDays }), 1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('휴게를 빼면 15시간에 30분 모자라 주휴일을 넣으면 400', async () => {
      const workDays = [
        day('MON', '09:00', '17:00', true),
        day('TUE', '09:00', '16:30'),
      ];
      await expect(
        service.create(dto({ workDays, weeklyHoliday: 'SUN' }), 1),
      ).rejects.toThrow('15시간 미만이면 주휴일이 없습니다');
    });

    it('주 15시간 미만이면 비워서 저장한다', async () => {
      await service.create(
        dto({ workDays: [day('MON', '09:00', '13:00')] }),
        1,
      );
      expect(created().contracts).toMatchObject({
        create: { weeklyHoliday: null },
      });
    });
  });

  // 수습(노무사 확인 2026-10-14) — 정직원 · 계약 기간 1년 이상(또는 기간의 정함 없음), 기간과 감액률은 함께.
  describe('수습', () => {
    const probation = { probationMonths: 3, probationWageReductionRate: 10 };

    it('기간의 정함이 없는 정직원이면 저장한다', async () => {
      await service.create(dto(probation), 1);
      expect(created().contracts).toMatchObject({ create: probation });
    });

    it('계약 기간이 딱 1년이면 저장한다', async () => {
      await service.create(
        dto({ ...probation, startDate: '2026-09-14', endDate: '2027-09-13' }),
        1,
      );
      expect(created().contracts).toMatchObject({ create: probation });
    });

    it('계약 기간이 1년보다 하루 짧으면 400', async () => {
      await expect(
        service.create(
          dto({ ...probation, startDate: '2026-09-14', endDate: '2027-09-12' }),
          1,
        ),
      ).rejects.toThrow('1년 이상');
    });

    it('파트타이머면 400', async () => {
      await expect(
        service.create(dto({ ...probation, employmentType: 'PART_TIME' }), 1),
      ).rejects.toThrow('정직원만');
    });

    it('기간만 넣으면 400', async () => {
      await expect(
        service.create(dto({ probationMonths: 2 }), 1),
      ).rejects.toThrow('함께');
    });

    it('수습이 없으면 두 칸을 비운다', async () => {
      await service.create(dto(), 1);
      expect(created().contracts).toMatchObject({
        create: { probationMonths: null, probationWageReductionRate: null },
      });
    });
  });

  it('급여 지급 방식을 저장한다', async () => {
    await service.create(dto({ payMethod: 'CASH' }), 1);
    expect(created().contracts).toMatchObject({
      create: { payMethod: 'CASH' },
    });
  });

  it('종료일이 있으면 날짜로 넣는다', async () => {
    await service.create(dto({ endDate: '2027-09-13' }), 1);
    expect(created().contracts).toMatchObject({
      create: { endDate: new Date('2027-09-13T00:00:00.000Z') },
    });
  });

  // 계약 시작일 기준 (운영 정책 ACC-22). 생일 전날까지는 한 살 적다.
  it.each([
    ['생일 전날이면 만 18세라 막는다', '2007-09-15', true],
    ['생일 당일이면 만 19세라 받는다', '2007-09-14', false],
  ])('%s', async (_, birthDate, blocked) => {
    const run = service.create(dto({ birthDate }), 1);
    if (blocked) {
      await expect(run).rejects.toThrow(BadRequestException);
      await expect(run).rejects.toThrow('만 19세 미만');
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toBeDefined();
    }
  });

  it.each<[string, Partial<CreateContractDto>, string]>([
    ['종료일이 시작일보다 앞', { endDate: '2026-09-13' }, '종료일'],
    [
      '같은 요일을 두 번',
      {
        workDays: [
          { weekday: 'MON', startTime: '09:00', endTime: '12:00' },
          { weekday: 'MON', startTime: '13:00', endTime: '18:00' },
        ],
      },
      '요일',
    ],
    [
      '종업이 시업보다 앞',
      { workDays: [{ weekday: 'MON', startTime: '18:00', endTime: '09:00' }] },
      '종업',
    ],
    [
      '휴게를 한쪽만',
      {
        workDays: [
          {
            weekday: 'MON',
            startTime: '09:00',
            endTime: '18:00',
            breakStartTime: '12:00',
          },
        ],
      },
      '휴게',
    ],
    [
      '휴게가 근무 밖',
      {
        workDays: [
          {
            weekday: 'MON',
            startTime: '09:00',
            endTime: '18:00',
            breakStartTime: '08:00',
            breakEndTime: '09:30',
          },
        ],
      },
      '휴게',
    ],
  ])('%s 이면 400', async (_, over, message) => {
    const run = service.create(dto(over), 1);
    await expect(run).rejects.toThrow(BadRequestException);
    await expect(run).rejects.toThrow(message);
    expect(prisma.staffMember.create).not.toHaveBeenCalled();
  });

  it('점포가 없거나 지워졌거나 폐점이면 404', async () => {
    prisma.store.findFirst.mockResolvedValue(null);

    await expect(service.create(dto(), 1)).rejects.toThrow(NotFoundException);
    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: {
        storeId: 11,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
      select: { storeId: true },
    });
  });

  it('업무 범위 밖 점포면 404 — 직원 레코드를 만들지 않는다', async () => {
    scope.canManageStaffAt.mockResolvedValue(false);

    await expect(service.create(dto(), 5)).rejects.toThrow(
      '근무지 점포를 찾을 수 없습니다',
    );
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(5, 11, false);
    expect(prisma.staffMember.create).not.toHaveBeenCalled();
  });

  // 「계정 있음 · 이 점포 재직 중 → 차단」(목업 contracts-new 초대 유형 판별). 계정 조회 없이도 레코드로 막는다.
  it('같은 점포에 같은 번호로 가입한 재직 직원이 있으면 409', async () => {
    prisma.staffMember.findFirst.mockResolvedValue({ staffMemberId: 9 });

    await expect(service.create(dto(), 1)).rejects.toThrow(ConflictException);
    expect(prisma.staffMember.findFirst).toHaveBeenCalledWith({
      where: {
        storeId: 11,
        phone: '01090145563',
        joinStatus: 'JOINED',
        employmentStatus: 'EMPLOYED',
      },
      select: { staffMemberId: true },
    });
    expect(prisma.staffMember.create).not.toHaveBeenCalled();
  });

  // 가입 전 레코드는 재직 상태가 기본값(EMPLOYED)이다. 앞 계약이 거부 · 만료로 끝나 남아도 새 초안을 막지 않는다.
  it('가입 전 레코드는 재직 확인에서 보지 않는다', async () => {
    await service.create(dto(), 1);
    expect(prisma.staffMember.findFirst.mock.calls[0][0].where).toMatchObject({
      joinStatus: 'JOINED',
    });
  });

  it('같은 번호로 잠근 뒤 한 트랜잭션에서 재직 확인 · 판별 · 생성을 한다 — 다른 점포 겹침도 보므로 점포는 키에 없다', async () => {
    await service.create(dto(), 1);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0][1]).toBe('contracts:01090145563');
    const lockedAt = prisma.$executeRaw.mock.invocationCallOrder[0];
    expect(lockedAt).toBeLessThan(
      prisma.staffMember.findFirst.mock.invocationCallOrder[0],
    );
    expect(lockedAt).toBeLessThan(
      prisma.account.findMany.mock.invocationCallOrder[0],
    );
  });
  // 종이 계약 등록(CTR-23) — 날인본과 함께 받아 발송 · 날인 없이 체결 완료로 저장한다.
  describe('종이 계약', () => {
    const PDF = Buffer.from('%PDF-1.7 날인본');
    const employment: PaperDocument = {
      kind: 'PAPER_EMPLOYMENT_CONTRACT',
      fileName: '근로계약서.pdf',
      buffer: PDF,
      fileType: 'PDF',
    };
    const wage: PaperDocument = {
      kind: 'WAGE_CONTRACT',
      fileName: '임금계약서.png',
      buffer: Buffer.from('png'),
      fileType: 'PNG',
    };
    const paper = (over: Partial<CreateContractDto> = {}) =>
      dto({ contractMethod: 'PAPER', ...over });

    it('날인본과 함께 받으면 체결 완료 · 이력으로 만들고 파일을 올려 행을 남긴다', async () => {
      await expect(
        service.create(paper(), 1, [employment, wage]),
      ).resolves.toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'SIGNED',
        draftAction: null,
      });
      expect(created().contracts).toMatchObject({
        create: {
          status: 'SIGNED',
          contractMethod: 'PAPER',
          contractStatusHistories: {
            create: { toStatus: 'SIGNED', actor: 'ADMIN' },
          },
        },
      });
      expect(storage.put).toHaveBeenCalledTimes(2);
      const [key, body, kind] = storage.put.mock.calls[0];
      expect(key).toMatch(/^contracts\/7\/[0-9a-f-]{36}\.pdf$/);
      expect(body).toBe(PDF);
      expect(kind).toBe('PDF');
      expect(prisma.contractDocument.createMany).toHaveBeenCalledWith({
        data: [
          {
            contractId: 7,
            kind: 'PAPER_EMPLOYMENT_CONTRACT',
            storageKey: key,
            checksum: createHash('sha256').update(PDF).digest('hex'),
            fileName: '근로계약서.pdf',
          },
          expect.objectContaining({
            kind: 'WAGE_CONTRACT',
            fileName: '임금계약서.png',
            storageKey: expect.stringMatching(/\.png$/) as unknown,
          }),
        ],
      });
      expect(storage.delete).not.toHaveBeenCalled();
      // 곧바로 체결 완료라 입사일이 비어 있으면 계약 시작일로(WHALEERP-613)
      expect(prisma.staffMember.updateMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: 3,
          hiredDate: null,
          // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
          OR: [
            { retiredDate: null },
            { retiredDate: { gte: new Date('2026-09-14T00:00:00.000Z') } },
          ],
        },
        data: { hiredDate: new Date('2026-09-14T00:00:00.000Z') },
      });
    });

    it('같은 번호 · 이름의 가입 전 레코드를 다시 쓰면 그 레코드의 빈 입사일만 채운다 — 이미 있으면 updateMany 가 건너뛴다', async () => {
      prisma.staffMember.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          staffMemberId: 4,
          joinStatus: 'DRAFT',
          candidateAccountId: null,
        });
      await expect(service.create(paper(), 1, [employment])).resolves.toEqual({
        contractId: 8,
        staffMemberId: 4,
        status: 'SIGNED',
        draftAction: null,
      });
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
      expect(prisma.staffMember.updateMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: 4,
          hiredDate: null,
          // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
          OR: [
            { retiredDate: null },
            { retiredDate: { gte: new Date('2026-09-14T00:00:00.000Z') } },
          ],
        },
        data: { hiredDate: new Date('2026-09-14T00:00:00.000Z') },
      });
    });

    it('전자계약 · 임시저장은 체결 완료가 아니라 입사일을 건드리지 않는다', async () => {
      await service.create(dto(), 1);
      await service.create(paper({ isTemporarySave: true }), 1);
      expect(prisma.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('근로계약서 날인본이 없으면 400 — 아무것도 만들지 않는다', async () => {
      await expect(service.create(paper(), 1, [wage])).rejects.toThrow(
        '근로계약서 파일과 함께 등록합니다',
      );
      await expect(service.create(paper(), 1)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('전자계약 · 임시저장에 날인본을 실으면 400', async () => {
      await expect(service.create(dto(), 1, [employment])).rejects.toThrow(
        '종이 계약을 등록할 때만',
      );
      await expect(
        service.create(paper({ isTemporarySave: true }), 1, [employment]),
      ).rejects.toThrow('종이 계약을 등록할 때만');
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('종이 계약도 임시저장은 파일 없이 임시저장으로 둔다', async () => {
      await service.create(paper({ isTemporarySave: true }), 1);
      expect(created().contracts).toMatchObject({
        create: { status: 'DRAFT', contractMethod: 'PAPER' },
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('파일을 올린 뒤 DB 저장이 실패하면 올린 파일을 지운다', async () => {
      prisma.contractDocument.createMany.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(
        service.create(paper(), 1, [employment, wage]),
      ).rejects.toThrow('db down');
      expect(storage.delete).toHaveBeenCalledTimes(2);
      expect(storage.delete.mock.calls.map(([k]) => k)).toEqual(
        storage.put.mock.calls.map(([k]) => k),
      );
    });

    it('저장소 설정이 없으면 503 — 계약도 만들지 않는다', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ContractsService,
          { provide: PrismaService, useValue: prisma },
          { provide: AdminScopeService, useValue: scope },
          { provide: STORAGE, useValue: null },
          { provide: ContractDeliveryService, useValue: delivery },
          { provide: ContractFilesService, useValue: { afterSent: jest.fn() } },
        ],
      }).compile();
      await expect(
        module.get(ContractsService).create(paper(), 1, [employment]),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });
  });
  // api #49 리뷰 — 체결 완료 중복 · 업로드 오류 · 트랜잭션 제한 시간 · 내려받기 확인 순서
  describe('종이 계약 리뷰 반영', () => {
    const PDF = Buffer.from('%PDF-1.7');
    const employment: PaperDocument = {
      kind: 'PAPER_EMPLOYMENT_CONTRACT',
      fileName: 'a.pdf',
      buffer: PDF,
      fileType: 'PDF',
    };
    const paper = (over: Partial<CreateContractDto> = {}) =>
      dto({ contractMethod: 'PAPER', ...over });
    const whereAsked = () =>
      (
        (prisma.contract.findMany.mock.calls as unknown[][])[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;

    const signed = {
      contractId: 5,
      status: 'SIGNED',
      staffMemberId: 3,
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-10-01T00:00:00Z'),
      previousContractId: null,
      staffMember: { name: '남도연' },
    };

    it('기간이 겹치는 체결 완료 계약이 있으면 대체하지 않고 409 SIGNED_CONTRACT_OVERLAP — 두 번 눌러도 두 벌이 생기지 않는다(WHALEERP-156)', async () => {
      // 자동 재계약 없음 → 겹치는 체결 완료 있음
      prisma.contract.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ contractId: 5 });
      prisma.contract.findMany.mockResolvedValueOnce([signed]);
      const error = await service
        .create(paper({ endDate: '2027-08-31' }), 1, [employment])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      // 바로잡기가 대체할 계약을 이름 · 기간과 함께 싣는다
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'SIGNED_CONTRACT_OVERLAP',
        contracts: [
          {
            contractId: 5,
            status: 'SIGNED',
            name: '남도연',
            startDate: '2026-09-01',
            endDate: '2026-10-01',
          },
        ],
      });
      // 겹침은 같은 점포 · 같은 번호의 체결 완료와 기간으로 본다 — 시작일이 빈 옛 계약은 처음부터, 종료일이 빈 계약은 끝없이
      const overlapArgs = prisma.contract.findFirst.mock.calls[1] as [
        { where: Record<string, unknown> },
      ];
      expect(overlapArgs[0].where).toEqual({
        storeId: 11,
        status: 'SIGNED',
        staffMember: { phone: '01090145563' },
        contractId: { notIn: [] },
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: new Date('2026-09-14T00:00:00Z') } },
            ],
          },
          {
            OR: [
              { startDate: null },
              { startDate: { lte: new Date('2027-08-31T00:00:00Z') } },
            ],
          },
        ],
      });
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('겹치지 않는 체결 완료 계약은 대체하지 않고 그대로 둔 채 등록한다', async () => {
      await service.create(paper(), 1, [employment]);
      // 대체 대상은 진행 중 계약만 — 체결 완료는 묻지 않는다
      expect(whereAsked()).toEqual({
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
      });
      expect(prisma.staffMember.create).toHaveBeenCalled();
    });

    it('잘못 올린 계약 바로잡기는 체결 완료도 대체를 묻는다 — 이름 · 종료일 · 재직과 상관없이 같은 점포 · 같은 번호면(api #49 3차 리뷰)', async () => {
      // 바로잡을 재계약을 찾을 때 · 대체할 계약을 물을 때 두 번 읽는다
      prisma.contract.findMany
        .mockResolvedValueOnce([signed])
        .mockResolvedValueOnce([signed]);
      const error = await service
        .create(paper({ correctSignedContracts: true }), 1, [employment])
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_IN_PROGRESS',
        contracts: [{ contractId: 5, status: 'SIGNED', name: '남도연' }],
      });
      expect(whereAsked()).toEqual({
        storeId: 11,
        status: {
          in: [
            'DRAFT',
            'PENDING_SEND',
            'PENDING_SIGNATURE',
            'CORRECTION_REQUESTED',
            'SIGNED',
          ],
        },
        staffMember: { phone: '01090145563' },
      });
      // 바로잡기는 재계약이 아니라 직전 계약을 저절로 찾지도, 겹침을 보지도 않는다
      expect(prisma.contract.findFirst).not.toHaveBeenCalled();
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

    it('잘못 올린 계약 바로잡기는 종이 계약 등록에서만, 재계약과 함께 쓸 수 없다 — 400', async () => {
      await expect(
        service.create(dto({ correctSignedContracts: true }), 1),
      ).rejects.toThrow(
        '잘못 올린 계약 바로잡기는 종이 계약을 등록할 때만 할 수 있습니다',
      );
      await expect(
        service.create(
          paper({ correctSignedContracts: true, previousContractId: 5 }),
          1,
          [employment],
        ),
      ).rejects.toThrow(
        '잘못 올린 계약 바로잡기는 재계약과 함께 할 수 없습니다',
      );
    });

    it('전자계약 초안 저장은 체결 완료를 대체 대상으로 묻지 않는다(재계약)', async () => {
      await service.create(dto(), 1);
      expect(whereAsked()).toMatchObject({
        status: {
          in: [
            'DRAFT',
            'PENDING_SEND',
            'PENDING_SIGNATURE',
            'CORRECTION_REQUESTED',
          ],
        },
      });
    });

    it('저장소 업로드가 실패하면 503 — 원인은 로그에만, 계약은 남지 않는다', async () => {
      storage.put.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(service.create(paper(), 1, [employment])).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.contractDocument.createMany).not.toHaveBeenCalled();
      // 올리려던 키도 지운다(없어도 지우기는 실패하지 않는다)
      expect(storage.delete).toHaveBeenCalledTimes(1);
      // 날인본은 썸네일이 없어 원본만 지운다(5차 참고 2)
      expect(storage.delete).toHaveBeenCalledWith(expect.any(String), {
        thumbnail: false,
      });
    });

    const txOptions = () =>
      (prisma.$transaction.mock.calls as unknown[][])[0][1];

    it('쓰기 트랜잭션이 시간을 넘기면(P2028) 503 — 올린 날인본은 지운다', async () => {
      prisma.$transaction.mockImplementationOnce(
        async (work: (t: typeof prisma) => Promise<unknown>) => {
          await work(prisma);
          throw new Prisma.PrismaClientKnownRequestError('timeout', {
            code: 'P2028',
            clientVersion: 'test',
          });
        },
      );
      await expect(service.create(paper(), 1, [employment])).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledTimes(1);
    });

    it('날인본이 있으면 쓰기 트랜잭션에 60초 제한 시간을 준다 — 없으면 기본값', async () => {
      await service.create(paper(), 1, [employment]);
      expect(txOptions()).toEqual({ timeout: 60_000 });
      prisma.$transaction.mockClear();
      await service.create(dto(), 1);
      expect(txOptions()).toBeUndefined();
    });

    it('내려받기 — 저장소 설정이 없어도 다른 계약의 파일이면 404(저장소 확인은 그 뒤)', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ContractsService,
          { provide: PrismaService, useValue: prisma },
          { provide: AdminScopeService, useValue: scope },
          { provide: STORAGE, useValue: null },
          { provide: ContractDeliveryService, useValue: delivery },
          { provide: ContractFilesService, useValue: { afterSent: jest.fn() } },
        ],
      }).compile();
      prisma.contract.findUnique.mockResolvedValueOnce({
        storeId: 11,
        staffMember: { account: { isHqSharingConsented: false } },
      });
      prisma.contractDocument.findFirst.mockResolvedValueOnce(null);
      await expect(
        module.get(ContractsService).documentDownloadUrl(1, 7, 99),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
