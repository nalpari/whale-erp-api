import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContractsService, weeklyHolidayOf } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

describe('ContractsService.create', () => {
  let service: ContractsService;
  let scope: { canManageStaffAt: jest.Mock };
  // 트랜잭션 안의 쿼리도 같은 객체로 받는다($transaction 이 자기를 넘긴다).
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock<Promise<number>, [TemplateStringsArray, string]>;
    store: {
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StoreFindFirstArgs]>;
    };
    account: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.AccountFindManyArgs]>;
    };
    staffMember: {
      findMany: jest.Mock<Promise<unknown[]>, [Prisma.StaffMemberFindManyArgs]>;
      findFirst: jest.Mock<Promise<unknown>, [Prisma.StaffMemberFindFirstArgs]>;
      create: jest.Mock<Promise<unknown>, [Prisma.StaffMemberCreateArgs]>;
    };
    // 중복 검사(contract-duplicates) — 기본은 진행 중 계약 · 다른 점포 계약이 없다
    contract: { findMany: jest.Mock };
  };

  const dto = (over: Partial<CreateContractDto> = {}): CreateContractDto => ({
    name: '남도현',
    phone: '01090145563',
    birthDate: '1998-07-12',
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
      },
      contract: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  const created = () => prisma.staffMember.create.mock.calls[0][0].data;

  it('직원 레코드(초안)와 발송 대기 계약 · 당사자 · 근무 요일 · 상태 이력을 한 번에 만든다', async () => {
    await expect(service.create(dto(), 1)).resolves.toEqual({
      contractId: 7,
      staffMemberId: 3,
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
      contracts: {
        create: {
          storeId: 11,
          employmentType: 'FULL_TIME',
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
          isHealthPensionInsured: true,
          isEmploymentInjuryInsured: false,
          status: 'PENDING_SEND',
          draftAction: 'SIGNUP_INVITE',
          createdBy: 1,
          contractParty: {
            create: {
              enteredName: '남도현',
              enteredPhone: '01090145563',
              enteredBirthDate: new Date('1998-07-12T00:00:00.000Z'),
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

  // 임시저장은 초대 · 계약서를 보내지 않는 저장이다. 상태와 첫 이력만 다르다.
  it('임시저장이면 임시저장(DRAFT) 상태와 이력으로 만든다', async () => {
    await service.create(dto({ isTemporarySave: true }), 1);
    expect(created().contracts).toMatchObject({
      create: {
        status: 'DRAFT',
        contractStatusHistories: {
          create: { toStatus: 'DRAFT', actor: 'ADMIN' },
        },
      },
    });
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
    it('같은 번호의 계정은 가장 최근 것 하나를 본다', async () => {
      await service.create(dto(), 1);
      expect(prisma.account.findMany).toHaveBeenCalledWith({
        where: { phone: '01090145563' },
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
      expect(prisma.account.findMany).not.toHaveBeenCalled();
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

  // 7일 모두 근무하는 경우를 협의하기 전까지 주휴일은 저장하지 않는다(늘 NULL, 2026-10-08). 화면에서도 숨긴다.
  describe('주휴일 저장', () => {
    it('주 40시간이어도 NULL 로 저장한다', async () => {
      const workDays = weekdays
        .slice(0, 5)
        .map((w) => day(w, '09:00', '18:00', true));
      await service.create(dto({ workDays }), 1);
      expect(created().contracts).toMatchObject({
        create: { weeklyHoliday: null },
      });
    });

    it('7일 모두 근무해도 막지 않는다', async () => {
      const workDays = weekdays.map((w) => day(w, '09:00', '12:00'));
      await expect(service.create(dto({ workDays }), 1)).resolves.toBeDefined();
      expect(created().contracts).toMatchObject({
        create: { weeklyHoliday: null },
      });
    });
  });

  // 협의 뒤 쓸 규칙 — 주 소정근로시간 15시간 이상이면 월~일 중 근무하지 않는 가장 뒤 요일, 미만이면 없음.
  describe('weeklyHolidayOf (지금은 저장에 쓰지 않는다)', () => {
    it.each<[string, WorkDay[], string | null]>([
      [
        '월~금 하루 8시간(주 40시간)이면 일요일',
        weekdays.slice(0, 5).map((w) => day(w, '09:00', '18:00', true)),
        'SUN',
      ],
      [
        '일요일에 근무하면 토요일',
        (['MON', 'TUE', 'SUN'] as const).map((w) => day(w, '09:00', '15:00')),
        'SAT',
      ],
      [
        '토 · 일 모두 근무하면 금요일',
        (['MON', 'SAT', 'SUN'] as const).map((w) => day(w, '09:00', '15:00')),
        'FRI',
      ],
      [
        '정확히 주 15시간이면 지정',
        [day('MON', '09:00', '16:30'), day('TUE', '09:00', '16:30')],
        'SUN',
      ],
      [
        '휴게를 빼면 30분 모자라 없음',
        [day('MON', '09:00', '17:00', true), day('TUE', '09:00', '16:30')],
        null,
      ],
      ['주 15시간 미만이면 없음', [day('MON', '09:00', '13:00')], null],
    ])('%s', (_, workDays, expected) => {
      expect(weeklyHolidayOf(workDays)).toBe(expected);
    });

    it('주 15시간 이상인데 7일 모두 근무하면 둘 요일이 없다 — 이 경우를 협의 중이다', () => {
      expect(() =>
        weeklyHolidayOf(weekdays.map((w) => day(w, '09:00', '12:00'))),
      ).toThrow('주휴일');
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
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(5, 11);
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
});
