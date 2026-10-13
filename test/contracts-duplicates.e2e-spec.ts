import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ContractsService } from '../src/contracts/contracts.service';
import { CreateContractDto } from '../src/contracts/dto/create-contract.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 계약 중복 검사(WHALEERP-129)를 실제 DB 로 확인한다. 대체(지우기 · 종료) · 가입 전 레코드 재사용 · 다른 점포
// 근무 시간 겹침이 여러 표와 관계 조건(staffMember.phone, contracts none)에 걸쳐 있어 목으로는 증명되지 않는다.
describe('계약 중복 검사 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let contracts: ContractsService;

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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    contracts = app.get(ContractsService);

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
    expect(body).toMatchObject({
      code: 'WORK_TIME_OVERLAP',
      overlaps: [{ weekday: 'MON', startTime: '14:00', endTime: '16:00' }],
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
