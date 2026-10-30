import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  BizppurioClient,
  BizppurioError,
} from './../src/alimtalk/bizppurio.client';
import { fakeBizppurio } from './fake-alimtalk';
import { ContractSendService } from '../src/contracts/contract-send.service';
import { ContractsService } from '../src/contracts/contracts.service';
import { CreateContractDto } from '../src/contracts/dto/create-contract.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { RetirementService } from '../src/staff-members/retirement.service';
import { StaffSignupService } from '../src/staff-signup/staff-signup.service';

// 계약 중복 검사(WHALEERP-129)를 실제 DB 로 확인한다. 대체(지우기 · 종료) · 가입 전 레코드 재사용 · 다른 점포
// 근무 시간 겹침이 여러 표와 관계 조건(staffMember.phone, contracts none)에 걸쳐 있어 목으로는 증명되지 않는다.
describe('계약 중복 검사 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let contracts: ContractsService;
  const bizppurio = fakeBizppurio();
  let retirement: RetirementService;
  let sender: ContractSendService;
  let signup: StaffSignupService;

  let bpCodeId: number;
  let storeId: number;
  let otherStoreId: number;
  let adminId: number;
  const n = randomInt(100_000, 999_999);
  // 사람마다 다른 번호 — 테스트끼리 섞이지 않게
  let seq = 0;
  const nextPhone = () => `010${n}${String(seq++).padStart(2, '0')}`;

  const dto = (
    phone: string,
    over: Partial<CreateContractDto> = {},
  ): CreateContractDto => ({
    name: '남도현',
    phone,
    birthDate: '1998-07-12',
    storeId,
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

  /** 409 응답 본문. 409 가 아니면 실패한다. */
  const conflictOf = async (run: Promise<unknown>) => {
    const e: unknown = await run.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(409);
    return (e as HttpException).getResponse() as Record<string, unknown>;
  };

  const recordsOf = (phone: string, store = storeId) =>
    prisma.staffMember.findMany({ where: { storeId: store, phone } });

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    // 근로계약 저장 · 발송이 가입 초대 알림톡을 보낸다 — 바깥 발송만 가짜로, 템플릿 렌더 · 발송 이력은 실제로 돈다(WHALEERP-616)
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BizppurioClient)
      .useValue(bizppurio)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    contracts = app.get(ContractsService);
    retirement = app.get(RetirementService);
    sender = app.get(ContractSendService);
    signup = app.get(StaffSignupService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '중복 검사 테스트 BP',
      },
    }));
    const store = (code: string, name: string) =>
      prisma.store.create({
        data: {
          storeCode: code,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ storeId } = await store(`ST${n}`, '중복 검사 점포'));
    ({ storeId: otherStoreId } = await store(
      `ST${(n + 1) % 1_000_000}`,
      '다른 점포',
    ));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `dup${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('같은 점포의 임시저장을 대체하면 그 행을 지우고, 같은 직원 레코드에 새 계약을 잇는다', async () => {
    const phone = nextPhone();
    const first = await contracts.create(
      dto(phone, { isTemporarySave: true }),
      adminId,
    );

    const body = await conflictOf(contracts.create(dto(phone), adminId));
    expect(body).toMatchObject({
      code: 'CONTRACT_IN_PROGRESS',
      contracts: [{ contractId: first.contractId, status: 'DRAFT' }],
    });

    const second = await contracts.create(
      dto(phone, { replaceContractIds: [first.contractId] }),
      adminId,
    );
    expect(second.staffMemberId).toBe(first.staffMemberId);
    await expect(
      prisma.contract.findUnique({ where: { contractId: first.contractId } }),
    ).resolves.toBeNull();
    expect(await recordsOf(phone)).toHaveLength(1);
  });

  it('발송 대기를 대체하면 종료로 닫고 이력을 남긴다', async () => {
    const phone = nextPhone();
    const first = await contracts.create(dto(phone), adminId);

    await contracts.create(
      dto(phone, { replaceContractIds: [first.contractId] }),
      adminId,
    );

    const closed = await prisma.contract.findUniqueOrThrow({
      where: { contractId: first.contractId },
      include: { contractStatusHistories: { orderBy: { changedAt: 'asc' } } },
    });
    expect(closed.status).toBe('ENDED');
    expect(closed.contractStatusHistories.at(-1)).toMatchObject({
      fromStatus: 'PENDING_SEND',
      toStatus: 'ENDED',
      actor: 'ADMIN',
    });
    expect(await recordsOf(phone)).toHaveLength(1);
  });

  it('진행 중 계약이 없어도(거부 뒤) 같은 번호의 가입 전 레코드를 다시 쓴다', async () => {
    const phone = nextPhone();
    const first = await contracts.create(dto(phone), adminId);
    await prisma.contract.update({
      where: { contractId: first.contractId },
      data: { status: 'REJECTED' },
    });

    const second = await contracts.create(dto(phone), adminId);
    expect(second.staffMemberId).toBe(first.staffMemberId);
    expect(await recordsOf(phone)).toHaveLength(1);
  });

  it('다른 점포 계약과 근무 시간이 겹치면 초안 저장을 막고, 임시저장 · 겹치지 않는 시간은 받는다', async () => {
    const phone = nextPhone();
    await contracts.create(dto(phone), adminId); // 월 10:00-16:00

    const elsewhere = (over: Partial<CreateContractDto>) =>
      dto(phone, { storeId: otherStoreId, ...over });
    const body = await conflictOf(
      contracts.create(
        elsewhere({
          workDays: [{ weekday: 'MON', startTime: '14:00', endTime: '20:00' }],
        }),
        adminId,
      ),
    );
    // 겹쳤다는 것만 — 다른 점포의 요일 · 시각은 싣지 않는다(CTR-26)
    expect(body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'WORK_TIME_OVERLAP',
      message: '다른 점포 근로계약과 근무 시간이 겹칩니다.',
    });
    expect(await recordsOf(phone, otherStoreId)).toHaveLength(0);

    // 임시저장은 보지 않는다
    const draft = await contracts.create(
      elsewhere({
        isTemporarySave: true,
        workDays: [{ weekday: 'MON', startTime: '14:00', endTime: '20:00' }],
      }),
      adminId,
    );
    // 이어 쓰기로 초안 저장에 넘길 때 다시 본다
    await conflictOf(
      contracts.update(
        adminId,
        draft.contractId,
        elsewhere({
          workDays: [{ weekday: 'MON', startTime: '14:00', endTime: '20:00' }],
        }),
      ),
    );
    // 맞닿는 시간(16:00 시업)이면 받는다
    await expect(
      contracts.update(
        adminId,
        draft.contractId,
        elsewhere({
          workDays: [{ weekday: 'MON', startTime: '16:00', endTime: '20:00' }],
        }),
      ),
    ).resolves.toMatchObject({ contractId: draft.contractId });
  });

  it('퇴직한 레코드의 계약은 퇴직일까지만 겹침을 본다', async () => {
    const phone = nextPhone();
    const { contractId, staffMemberId } = await contracts.create(
      dto(phone),
      adminId,
    ); // 월 10:00-16:00, 11-01 부터 종료일 없음
    await prisma.contract.update({
      where: { contractId },
      data: { status: 'SIGNED' },
    });
    // 퇴직 처리는 체결 완료 계약을 닫지 않는다
    await prisma.staffMember.update({
      where: { staffMemberId },
      data: {
        employmentStatus: 'RETIRED',
        retiredDate: new Date('2026-12-31T00:00:00.000Z'),
      },
    });
    const elsewhere = (startDate: string) =>
      dto(phone, { storeId: otherStoreId, startDate });

    // 퇴직일 전부터면 겹친다
    await conflictOf(contracts.create(elsewhere('2026-12-01'), adminId));
    // 퇴직일 뒤부터면 받는다
    await expect(
      contracts.create(elsewhere('2027-01-01'), adminId),
    ).resolves.toMatchObject({ contractId: expect.any(Number) as number });
  });

  it('같은 번호라도 이름이 다르면 가입 전 레코드를 다시 쓰지 않고 새로 만든다', async () => {
    const phone = nextPhone();
    const first = await contracts.create(dto(phone), adminId);
    await prisma.contract.update({
      where: { contractId: first.contractId },
      data: { status: 'REJECTED' },
    });

    const second = await contracts.create(
      dto(phone, { name: '김새봄' }),
      adminId,
    );
    expect(second.staffMemberId).not.toBe(first.staffMemberId);
    const before = await prisma.staffMember.findUniqueOrThrow({
      where: { staffMemberId: first.staffMemberId },
    });
    expect(before.name).toBe('남도현');
  });

  it('이름이 다른 사람으로 임시저장을 대체하면 새 레코드에 잇고, 계약을 잃은 옛 레코드는 지운다', async () => {
    const phone = nextPhone();
    const first = await contracts.create(
      dto(phone, { isTemporarySave: true }),
      adminId,
    );

    const second = await contracts.create(
      dto(phone, { name: '김새봄', replaceContractIds: [first.contractId] }),
      adminId,
    );
    expect(second.staffMemberId).not.toBe(first.staffMemberId);
    await expect(
      prisma.staffMember.findUnique({
        where: { staffMemberId: first.staffMemberId },
      }),
    ).resolves.toBeNull();
    expect(await recordsOf(phone)).toHaveLength(1);
  });

  // 상세(findOne)는 1:1 관계 둘을 한 쿼리로 읽는데 PGlite 가 그 쿼리에서 연결을 끊는다(main 에서도 같다).
  // 저장된 칸을 직접 읽어 보고, Decimal → number 변환은 단위 테스트(contracts.update.spec)가 본다.
  it('api #12 칸을 저장한다', async () => {
    const { contractId } = await contracts.create(
      dto(nextPhone(), {
        mealAllowanceAmount: 200000,
        baseHours: 209,
        baseNightHours: 12.5,
        severancePayTerms: '계속근로기간 1년에 대하여 30일분의 퇴직금을 지급함',
      }),
      adminId,
    );
    const saved = await prisma.contract.findUniqueOrThrow({
      where: { contractId },
      select: {
        mealAllowanceAmount: true,
        carAllowanceAmount: true,
        baseHours: true,
        baseNightHours: true,
        severancePayTerms: true,
      },
    });
    expect({
      ...saved,
      baseHours: saved.baseHours?.toNumber(),
      baseNightHours: saved.baseNightHours?.toNumber(),
    }).toEqual({
      mealAllowanceAmount: 200000,
      carAllowanceAmount: null,
      baseHours: 209,
      baseNightHours: 12.5,
      severancePayTerms: '계속근로기간 1년에 대하여 30일분의 퇴직금을 지급함',
    });
  });

  // 바깥 발송만 가짜다 — 가입 초대 알림톡은 DB 의 TALK_STAFF_INVITATION 템플릿으로 렌더해 보내고 이력을 남긴다. 템플릿
  // 변수가 바뀌어 운영 발송이 깨지면 여기서 드러난다(api #141 리뷰)
  it('가입 초대 알림톡은 DB 템플릿으로 렌더해 보내고 발송 이력을 남긴다', async () => {
    const phone = nextPhone();
    const { contractId } = await contracts.create(dto(phone), adminId);

    expect(bizppurio.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'at',
        to: phone,
        content: {
          at: expect.objectContaining({
            message: expect.stringContaining('중복 검사 점포') as string,
          }) as object,
        },
      }),
    );
    await expect(
      prisma.alimtalkSendLog.findFirst({
        where: { relatedType: 'contract', relatedId: contractId },
        select: { templateCode: true, result: true },
      }),
    ).resolves.toEqual({
      templateCode: 'TALK_STAFF_INVITATION',
      result: 'SUCCEEDED',
    });
  });

  // 재입사 레코드 연결(WHALEERP-615, 2026-10-22 김민식). 퇴직 뒤 다시 입사하면 새 레코드를 만들고(api #65) 같은 사람의 직전
  // 재직 레코드를 previous_staff_member_id 에 남긴다 — 가입한 직원은 같은 계정, 가입 전 직원은 같은 번호 · 이름.
  describe('재입사 레코드 연결 (WHALEERP-615)', () => {
    /** 계약을 끝내고 퇴직시킨다 — 진행 중 계약이 남으면 새 계약이 대체 확인(409)에 걸린다 */
    const retire = async (staffMemberId: number, retiredDate: string) => {
      await prisma.contract.updateMany({
        where: { staffMemberId },
        data: { status: 'ENDED' },
      });
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: {
          employmentStatus: 'RETIRED',
          retiredDate: new Date(retiredDate),
        },
      });
    };
    const previousOf = async (staffMemberId: number) =>
      (
        await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId },
          select: { previousStaffMemberId: true },
        })
      ).previousStaffMemberId;

    it('가입 전 직원이 퇴직 뒤 다시 입사하면 새 레코드에 옛 레코드를 잇는다 — 임시저장도', async () => {
      const phone = nextPhone();
      const first = await contracts.create(dto(phone), adminId);
      await retire(first.staffMemberId, '2026-06-30');

      const again = await contracts.create(
        dto(phone, { isTemporarySave: true }),
        adminId,
      );
      expect(again.staffMemberId).not.toBe(first.staffMemberId);
      expect(await previousOf(again.staffMemberId)).toBe(first.staffMemberId);
      // 옛 레코드는 그대로다
      expect(await previousOf(first.staffMemberId)).toBeNull();
    });

    it('이름이 다르면 다른 사람으로 보고 잇지 않는다 — 이어 쓰기로 이름을 바꾸면 끊고, 되돌리면 다시 잇는다', async () => {
      const phone = nextPhone();
      const first = await contracts.create(dto(phone), adminId);
      await retire(first.staffMemberId, '2026-06-30');

      const other = await contracts.create(
        dto(phone, { name: '김새봄', isTemporarySave: true }),
        adminId,
      );
      expect(await previousOf(other.staffMemberId)).toBeNull();

      await contracts.update(
        adminId,
        other.contractId,
        dto(phone, { isTemporarySave: true }),
      );
      expect(await previousOf(other.staffMemberId)).toBe(first.staffMemberId);
      await contracts.update(
        adminId,
        other.contractId,
        dto(phone, { name: '김새봄', isTemporarySave: true }),
      );
      expect(await previousOf(other.staffMemberId)).toBeNull();
    });

    it('근로자 정보 수정으로 이름을 바로잡아도 다시 찾는다', async () => {
      const phone = nextPhone();
      const first = await contracts.create(dto(phone), adminId);
      await retire(first.staffMemberId, '2026-06-30');
      const typo = await contracts.create(
        dto(phone, { name: '남도헌' }),
        adminId,
      );
      expect(await previousOf(typo.staffMemberId)).toBeNull();

      await contracts.updateWorker(adminId, typo.contractId, {
        name: '남도현',
        phone,
        birthDate: '1998-07-12',
      });
      expect(await previousOf(typo.staffMemberId)).toBe(first.staffMemberId);
    });

    it('가입한 직원은 같은 계정 · 같은 이름의 퇴직 레코드를 잇고(복귀 확인), 번호를 넘겨받은 다른 이름은 잇지 않는다', async () => {
      const phone = nextPhone();
      const account = await prisma.account.create({
        data: {
          email: `return-${n}-${seq}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          status: 'JOINED',
        },
      });
      const joined = await prisma.staffMember.create({
        data: {
          storeId,
          accountId: account.accountId,
          name: '남도현',
          phone,
          employmentType: 'PART_TIME',
          jobTitle: '바리스타',
          joinStatus: 'JOINED',
          employmentStatus: 'RETIRED',
          retiredDate: new Date('2026-06-30'),
        },
      });

      const again = await contracts.create(dto(phone), adminId);
      const created = await prisma.contract.findUniqueOrThrow({
        where: { contractId: again.contractId },
        select: { draftAction: true },
      });
      expect(created.draftAction).toBe('RETURN_CONFIRM');
      expect(await previousOf(again.staffMemberId)).toBe(joined.staffMemberId);

      // 임시저장은 초대 유형을 판별하지 않지만(후보 계정 없음) 계정으로 잇는다 — 같은 가입 전 레코드를 다시 쓰며 다시 찾는다
      await prisma.contract.update({
        where: { contractId: again.contractId },
        data: { status: 'ENDED' },
      });
      const draft = await contracts.create(
        dto(phone, { isTemporarySave: true }),
        adminId,
      );
      expect(draft.staffMemberId).toBe(again.staffMemberId);
      expect(await previousOf(draft.staffMemberId)).toBe(joined.staffMemberId);

      // 같은 번호라도 이름이 다르면 번호를 넘겨받은 다른 사람일 수 있다 — 가입 전 레코드 다시 쓰기와 같은 기준
      await contracts.remove(adminId, draft.contractId);
      const other = await contracts.create(
        dto(phone, { name: '김새봄', isTemporarySave: true }),
        adminId,
      );
      expect(await previousOf(other.staffMemberId)).toBeNull();
    });

    it('거부로 남은 가입 전 레코드를 다시 쓸 때도 옛 레코드를 잇는다', async () => {
      const phone = nextPhone();
      const first = await contracts.create(dto(phone), adminId);
      await retire(first.staffMemberId, '2026-06-30');
      const rejected = await contracts.create(dto(phone), adminId);
      await prisma.contract.update({
        where: { contractId: rejected.contractId },
        data: { status: 'REJECTED' },
      });
      await prisma.staffMember.update({
        where: { staffMemberId: rejected.staffMemberId },
        data: { previousStaffMemberId: null },
      });

      const again = await contracts.create(dto(phone), adminId);
      expect(again.staffMemberId).toBe(rejected.staffMemberId);
      expect(await previousOf(again.staffMemberId)).toBe(first.staffMemberId);
    });

    // 위 테스트들은 날짜를 고정하려고 퇴직 칸을 직접 쓴다. 실제 퇴직 처리(RetirementService — 지난 날짜면 곧바로 퇴직,
    // 오늘 이후면 퇴직 예정)로 끝낸 레코드도 같은 칸을 남겨 잇는지 본다.
    it('퇴직 처리로 퇴직한 레코드 · 퇴직 예정인 레코드를 잇는다', async () => {
      const day = (offset: number) => {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() + offset);
        return d;
      };
      const phone = nextPhone();
      const retired = await contracts.create(dto(phone), adminId);
      await retirement.retire(adminId, retired.staffMemberId, day(-10));
      const again = await contracts.create(dto(phone), adminId);
      expect(again.staffMemberId).not.toBe(retired.staffMemberId);
      expect(await previousOf(again.staffMemberId)).toBe(retired.staffMemberId);

      // 퇴직 예정이면 계약이 아직 진행 중이라 대체를 확인받고 새 계약을 쓴다
      await retirement.retire(adminId, again.staffMemberId, day(30));
      const third = await contracts.create(
        dto(phone, { replaceContractIds: [again.contractId] }),
        adminId,
      );
      expect(third.staffMemberId).not.toBe(again.staffMemberId);
      expect(await previousOf(third.staffMemberId)).toBe(again.staffMemberId);
    });

    it('퇴직(예정) 레코드의 계약을 고쳐도 그 레코드의 연결은 다시 찾지 않는다 — 그 자신이 지난 재직 기간이다', async () => {
      const phone = nextPhone();
      const first = await contracts.create(dto(phone), adminId);
      await retire(first.staffMemberId, '2026-06-30');
      const second = await contracts.create(dto(phone), adminId);
      expect(await previousOf(second.staffMemberId)).toBe(first.staffMemberId);
      await prisma.staffMember.update({
        where: { staffMemberId: second.staffMemberId },
        data: { retiredDate: new Date('2099-12-31') },
      });

      // 다른 이름으로 고치면 다시 찾을 때 연결이 비지만, 퇴직 예정 레코드라 그대로다
      await contracts.updateWorker(adminId, second.contractId, {
        name: '김새봄',
        phone,
        birthDate: '1998-07-12',
      });
      expect(await previousOf(second.staffMemberId)).toBe(first.staffMemberId);
    });

    it('근로자 정보 수정으로 번호를 바꾸면 새 번호의 계정 레코드를 잇는다', async () => {
      const phone = nextPhone();
      const account = await prisma.account.create({
        data: {
          email: `relink-${n}-${seq}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          status: 'JOINED',
        },
      });
      const joined = await prisma.staffMember.create({
        data: {
          storeId,
          accountId: account.accountId,
          name: '남도현',
          phone,
          employmentType: 'PART_TIME',
          jobTitle: '바리스타',
          joinStatus: 'JOINED',
          employmentStatus: 'RETIRED',
          retiredDate: new Date('2026-06-30'),
        },
      });
      const wrong = nextPhone();
      const typo = await contracts.create(dto(wrong), adminId);
      expect(await previousOf(typo.staffMemberId)).toBeNull();

      await contracts.updateWorker(adminId, typo.contractId, {
        name: '남도현',
        phone,
        birthDate: '1998-07-12',
      });
      expect(await previousOf(typo.staffMemberId)).toBe(joined.staffMemberId);
    });

    it('가리켜진 레코드를 지워도(임시저장 삭제) 외래키 오류 없이 연결만 끊는다', async () => {
      const draft = await contracts.create(
        dto(nextPhone(), { isTemporarySave: true }),
        adminId,
      );
      const other = await contracts.create(
        dto(nextPhone(), { isTemporarySave: true }),
        adminId,
      );
      // 저장은 퇴직 레코드만 잇는다 — 다른 길로 생긴 연결을 흉내 낸다
      await prisma.staffMember.update({
        where: { staffMemberId: other.staffMemberId },
        data: { previousStaffMemberId: draft.staffMemberId },
      });

      await contracts.remove(adminId, draft.contractId);
      await expect(
        prisma.staffMember.findUnique({
          where: { staffMemberId: draft.staffMemberId },
        }),
      ).resolves.toBeNull();
      expect(await previousOf(other.staffMemberId)).toBeNull();
    });

    it('건너서라도 자기를 이은 뒤 레코드는 잇지 않는다 — 퇴직을 취소한 앞 레코드를 고쳐도 사슬이 돌지 않는다', async () => {
      const phone = nextPhone();
      const a = await contracts.create(dto(phone), adminId);
      const later = (previous: number, retired: string) =>
        prisma.staffMember.create({
          data: {
            storeId,
            name: '남도현',
            phone,
            employmentType: 'PART_TIME',
            jobTitle: '바리스타',
            employmentStatus: 'RETIRED',
            retiredDate: new Date(retired),
            previousStaffMemberId: previous,
          },
        });
      // A(퇴직 취소로 다시 재직) ← B ← C — 둘 다 A 보다 늦게 퇴직했다
      const b = await later(a.staffMemberId, '2026-07-31');
      await later(b.staffMemberId, '2026-08-31');

      await contracts.updateWorker(adminId, a.contractId, {
        name: '남도현',
        phone,
        birthDate: '1998-07-12',
      });
      expect(await previousOf(a.staffMemberId)).toBeNull();
    });

    it('퇴직 레코드가 여럿이면 가장 늦게 퇴직한 것을 잇고, 다른 점포 레코드는 보지 않는다', async () => {
      const phone = nextPhone();
      const older = await contracts.create(dto(phone), adminId);
      await retire(older.staffMemberId, '2026-03-31');
      const later = await contracts.create(dto(phone), adminId);
      await retire(later.staffMemberId, '2026-06-30');
      const elsewhere = await contracts.create(
        dto(phone, { storeId: otherStoreId, startDate: '2027-01-01' }),
        adminId,
      );
      await retire(elsewhere.staffMemberId, '2026-09-30');

      const again = await contracts.create(dto(phone), adminId);
      expect(await previousOf(later.staffMemberId)).toBe(older.staffMemberId);
      expect(await previousOf(again.staffMemberId)).toBe(later.staffMemberId);
    });
  });

  // 계약 상세의 발송 · 처리 정보(WHALEERP-328)와 발송 대기 종료(WHALEERP-327, 2026-10-21 재영 A안)
  describe('계약 상세 발송 정보 · 발송 대기 종료 (WHALEERP-328 · 327)', () => {
    const later = (ms: number) => new Date(Date.now() + ms);

    it('처음 · 마지막 발송 일시와 날인 기한을 주고, 재발송하면 마지막 발송 일시 · 기한 · 재발송 횟수만 바뀐다', async () => {
      const { contractId } = await contracts.create(dto(nextPhone()), adminId);
      const first = await contracts.findOne(adminId, contractId);
      // 처음 발송은 상태 이력 시각(DB), 마지막 발송은 보낸 요청의 시각이라 몇 ms 다를 수 있다
      expect(
        Math.abs(
          Date.parse(first.lastSentAt as string) -
            Date.parse(first.firstSentAt as string),
        ),
      ).toBeLessThan(5_000);
      expect(first.signDeadlineAt).not.toBeNull();
      expect(first.lastProcessedAt).toBe(first.histories[0].changedAt);
      expect(first.resendCount).toBe(0);
      // 계정 없는 번호의 가입 초대라 재발송할 수 있다
      expect(first.canResend).toBe(true);
      expect(first.correctionReason).toBeNull();
      expect(first.registeredAt).toBeNull();
      expect(first.registeredBy).toBeNull();

      const at = later(60_000);
      await sender.send(adminId, contractId, at);
      const resent = await contracts.findOne(adminId, contractId);
      expect(resent.firstSentAt).toBe(first.firstSentAt);
      expect(resent.lastSentAt).toBe(at.toISOString());
      expect(resent.signDeadlineAt).not.toBe(first.signDeadlineAt);
      expect(resent.resendCount).toBe(1);
    });

    it('계정이 있는 번호의 가입 전 직원(소속 추가 확인)은 재발송하면 소속 추가 확인 요청을 새로 보낸다 — 상세가 알린다(WHALEERP-130)', async () => {
      const phone = nextPhone();
      const account = await prisma.account.create({
        data: {
          email: `resend-${n}-${seq}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          status: 'JOINED',
        },
      });
      const { contractId } = await contracts.create(dto(phone), adminId);
      const detail = await contracts.findOne(adminId, contractId);
      expect(detail.draftAction).toBe('AFFILIATION_CONFIRM');
      expect(detail.status).toBe('PENDING_SEND');
      expect(detail.canResend).toBe(true);
      // 날인 기한은 직원이 수락한 때부터라 재발송 응답의 기한은 없다
      await expect(sender.send(adminId, contractId)).resolves.toMatchObject({
        status: 'PENDING_SEND',
        signDeadlineAt: null,
      });
      expect(account.accountId).toBeGreaterThan(0);
    });

    it('재발송 알림톡이 나가지 않아 되돌리면 재발송 횟수도 그대로다', async () => {
      const { contractId } = await contracts.create(dto(nextPhone()), adminId);
      bizppurio.sendMessage.mockRejectedValueOnce(
        new BizppurioError('거절', 4100, 400),
      );

      await expect(
        sender.send(adminId, contractId, later(60_000)),
      ).rejects.toMatchObject({ status: 502 });
      expect((await contracts.findOne(adminId, contractId)).resendCount).toBe(
        0,
      );
    });

    it('상세는 수정 요청된 계약에만 직원이 남긴 수정 요청 사유를 주고 거부 사유 칸은 없다 — 고쳐 다시 보내도 행에는 남는다(WHALEERP-635)', async () => {
      const phone = nextPhone();
      const { contractId } = await contracts.create(dto(phone), adminId);
      await prisma.contract.update({
        where: { contractId },
        data: {
          status: 'CORRECTION_REQUESTED',
          correctionReason: '시급이 다릅니다',
        },
      });
      const requested = await contracts.findOne(adminId, contractId);
      expect(requested.correctionReason).toBe('시급이 다릅니다');
      expect(requested).not.toHaveProperty('rejectReason');

      // 고쳐 다시 보내면 행에는 남지만 상세는 수정 요청일 때만 준다
      await contracts.update(adminId, contractId, dto(phone));
      const resent = await contracts.findOne(adminId, contractId);
      expect(resent.status).toBe('PENDING_SEND');
      expect(resent.correctionReason).toBeNull();
      expect(
        (
          await prisma.contract.findUniqueOrThrow({
            where: { contractId },
            select: { correctionReason: true },
          })
        ).correctionReason,
      ).toBe('시급이 다릅니다');
    });

    it('발송 대기 계약을 종료로 닫으면 이력을 남기고 나간 초대를 무효로 한다 — 행은 남는다', async () => {
      const created = await contracts.create(dto(nextPhone()), adminId);
      expect(
        await prisma.invitation.count({
          where: { staffMemberId: created.staffMemberId, status: 'SENT' },
        }),
      ).toBe(1);

      await expect(sender.end(adminId, created.contractId)).resolves.toEqual({
        contractId: created.contractId,
        status: 'ENDED',
      });
      const detail = await contracts.findOne(adminId, created.contractId);
      expect(detail.status).toBe('ENDED');
      expect(detail.histories[0]).toMatchObject({
        fromStatus: 'PENDING_SEND',
        toStatus: 'ENDED',
        actor: 'ADMIN',
      });
      expect(
        await prisma.invitation.count({
          where: { staffMemberId: created.staffMemberId, status: 'SENT' },
        }),
      ).toBe(0);
    });

    it('종료한 계약의 초대 링크로는 가입 확인이 되지 않는다', async () => {
      const { contractId } = await contracts.create(dto(nextPhone()), adminId);
      // 가짜 비즈뿌리오가 받은 알림톡 본문에서 초대 링크 토큰을 꺼낸다(DB 에는 해시만 있다)
      const token = /token=([A-Za-z0-9_-]{43})/.exec(
        JSON.stringify(bizppurio.sendMessage.mock.calls.at(-1)),
      )?.[1];
      expect(token).toBeDefined();
      await expect(signup.check({ token })).resolves.toMatchObject({
        storeName: expect.any(String) as string,
      });

      await sender.end(adminId, contractId);
      await expect(signup.check({ token })).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('날인 대기(서명 대기)는 종료하지 못한다 — 409', async () => {
      const { contractId } = await contracts.create(dto(nextPhone()), adminId);
      await prisma.contract.update({
        where: { contractId },
        data: { status: 'PENDING_SIGNATURE' },
      });
      const body = await conflictOf(sender.end(adminId, contractId));
      expect(body).toMatchObject({ code: 'CONTRACT_STATUS_CONFLICT' });
    });

    it('가입한 직원 · 탈퇴 계정만 있는 번호는 재발송할 수 있다', async () => {
      const joined = await contracts.create(dto(nextPhone()), adminId);
      await prisma.contract.update({
        where: { contractId: joined.contractId },
        data: { status: 'PENDING_SIGNATURE' },
      });
      await prisma.staffMember.update({
        where: { staffMemberId: joined.staffMemberId },
        data: { joinStatus: 'JOINED' },
      });
      expect(
        (await contracts.findOne(adminId, joined.contractId)).canResend,
      ).toBe(true);

      const phone = nextPhone();
      await prisma.account.create({
        data: {
          email: `withdrawn-${n}-${seq}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          status: 'WITHDRAWN',
        },
      });
      const { contractId } = await contracts.create(dto(phone), adminId);
      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        true,
      );
    });

    it('발송 대기가 아니면 종료하지 못한다 — 409 에 지금 상태를 싣는다', async () => {
      const draft = await contracts.create(
        dto(nextPhone(), { isTemporarySave: true }),
        adminId,
      );
      const body = await conflictOf(sender.end(adminId, draft.contractId));
      expect(body).toMatchObject({ code: 'CONTRACT_STATUS_CONFLICT' });
      await expect(
        prisma.contract.findUniqueOrThrow({
          where: { contractId: draft.contractId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'DRAFT' });
    });
  });

  it('목록은 직원의 지금 가입 · 초대 상태와 퇴직 여부, 상태별 개수를 준다 (WHALEERP-133)', async () => {
    const phone = nextPhone();
    const { contractId, staffMemberId } = await contracts.create(
      dto(phone),
      adminId,
    );
    const rowOf = async () => {
      const page = await contracts.list(adminId, {
        page: 1,
        pageSize: 200,
        storeIds: [storeId],
      });
      return {
        row: page.items.find((i) => i.contractId === contractId),
        counts: page.statusCounts,
      };
    };

    const sent = await rowOf();
    expect(sent.row).toMatchObject({
      status: 'PENDING_SEND',
      draftAction: 'SIGNUP_INVITE',
      staffJoinState: 'INVITED',
      staffRetired: false,
    });
    expect(sent.counts.PENDING_SEND).toBeGreaterThanOrEqual(1);

    // 초대가 만료되면 저장 때 판별한 초대 유형은 그대로지만 가입 대기가 아니다
    await prisma.invitation.updateMany({
      where: { staffMemberId },
      data: { status: 'EXPIRED' },
    });
    expect((await rowOf()).row).toMatchObject({
      draftAction: 'SIGNUP_INVITE',
      staffJoinState: 'EXPIRED',
    });

    await prisma.staffMember.update({
      where: { staffMemberId },
      data: {
        employmentStatus: 'RETIRED',
        retiredDate: new Date('2026-01-31'),
      },
    });
    expect((await rowOf()).row?.staffRetired).toBe(true);
  });

  it('본사 역할에게 가려지는 가맹 점포의 동의 안 한 직원 계약은 목록에도 상태별 개수에도 없다 — 점포 하나로 좁혀 그 사람의 계약 상태가 드러나지 않게(api #146 리뷰)', async () => {
    const franchise = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 2) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '가맹 점포',
        storeStatusCode: 'OPERATING',
      },
    });
    // 가입 전 직원은 계정이 없어 본사 제공 동의를 하지 않은 것과 같다 — 본사 역할(BM)에게 가려진다. 본사 역할은 그런 점포에 계약을
    // 만들 수 없어(가려진 점포는 관리하지 못한다) 직영 점포에 만든 뒤 옮긴다
    const { contractId, staffMemberId } = await contracts.create(
      dto(nextPhone()),
      adminId,
    );
    await prisma.staffMember.update({
      where: { staffMemberId },
      data: { storeId: franchise.storeId },
    });
    await prisma.contract.update({
      where: { contractId },
      data: { storeId: franchise.storeId },
    });
    const query = { page: 1, pageSize: 20, storeIds: [franchise.storeId] };

    const page = await contracts.list(adminId, query);
    expect(page.items.map((i) => i.contractId)).not.toContain(contractId);
    expect(page.total).toBe(0);
    expect(page.statusCounts.PENDING_SEND).toBe(0);

    const named = await contracts.list(adminId, {
      ...query,
      staffMemberName: '남도현',
    });
    expect(named.statusCounts.PENDING_SEND).toBe(0);
  });

  // 연결 두 개가 필요해 PGlite(연결 하나)에서는 돌지 않는다 — 실제 PostgreSQL 일회용 DB 에서 돌린다.
  it('같은 임시저장에 삭제와 이어 쓰기가 함께 와도 500 없이 하나만 된다', async () => {
    const phone = nextPhone();
    const { contractId } = await contracts.create(
      dto(phone, { isTemporarySave: true }),
      adminId,
    );

    const results = await Promise.allSettled([
      contracts.remove(adminId, contractId),
      contracts.update(
        adminId,
        contractId,
        dto(phone, { isTemporarySave: true }),
      ),
    ]);
    const statuses = results.map((r) =>
      r.status === 'fulfilled'
        ? 200
        : (r.reason as HttpException).getStatus?.(),
    );
    // 먼저 잡은 쪽이 끝나고, 뒤에 온 쪽은 바뀐 상태를 읽어 404 다(지웠으면) — 이어 쓰기가 먼저면 둘 다 된다
    expect(statuses.every((s) => s === 200 || s === 404)).toBe(true);
  });
});
