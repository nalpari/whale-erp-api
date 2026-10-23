import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AlimtalkService } from './../src/alimtalk/alimtalk.service';
import { fakeAlimtalk } from './fake-alimtalk';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';
import { rejectContract, signContract } from '../src/contracts/contract-status';
import { ContractsService } from '../src/contracts/contracts.service';
import { CreateContractDto } from '../src/contracts/dto/create-contract.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 계약 상태 전환(WHALEERP-151)을 실제 DB 로 확인한다. 조건부 UPDATE · 상태 이력 · 거부 사유가 한 트랜잭션에서
// 함께 남고, 실패하면 직전 상태가 그대로인지는 목으로 증명되지 않는다.
describe('계약 상태 전환 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let contracts: ContractsService;
  let expiry: ContractExpiryService;

  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const n = randomInt(100_000, 999_999);
  let seq = 0;
  const nextPhone = () => `011${n}${String(seq++).padStart(2, '0')}`;

  const dto = (phone: string): CreateContractDto => ({
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
  });

  /** 발송은 아직 없다(WHALEERP-136) — 저장한 계약을 서명 대기로 바로 옮겨 둔다. */
  const sent = async (signDeadlineAt = new Date('2099-01-01T00:00:00Z')) => {
    const { contractId } = await contracts.create(dto(nextPhone()), adminId);
    await prisma.contract.update({
      where: { contractId },
      data: { status: 'PENDING_SIGNATURE', sentAt: new Date(), signDeadlineAt },
    });
    return contractId;
  };

  const stateOf = (contractId: number) =>
    prisma.contract.findUniqueOrThrow({
      where: { contractId },
      select: {
        status: true,
        rejectReason: true,
        contractStatusHistories: {
          orderBy: { contractStatusHistoryId: 'asc' },
          select: { fromStatus: true, toStatus: true, actor: true },
        },
      },
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

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    // 근로계약 저장 · 발송이 가입 초대 알림톡을 보낸다 — 실제로 보내지 않게 갈아 끼운다(WHALEERP-616)
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AlimtalkService)
      .useValue(fakeAlimtalk())
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    contracts = app.get(ContractsService);
    expiry = app.get(ContractExpiryService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${String((n + 500_000) % 1_000_000).padStart(6, '0')}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '상태 전환 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${String((n + 500_000) % 1_000_000).padStart(6, '0')}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '상태 전환 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `sts${n}`,
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

  it('날인하면 체결 완료와 직원 처리 이력이 함께 남고, 다시 날인하면 지금 상태를 알린다', async () => {
    const contractId = await sent();

    await prisma.$transaction((tx) => signContract(tx, contractId));
    const signed = await stateOf(contractId);
    expect(signed.status).toBe('SIGNED');
    expect(signed.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'PENDING_SIGNATURE',
      toStatus: 'SIGNED',
      actor: 'STAFF',
    });

    const body = await conflictOf(
      prisma.$transaction((tx) => signContract(tx, contractId)),
    );
    expect(body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'SIGNED',
    });
    // 이력이 한 줄 더 생기지 않았다
    expect((await stateOf(contractId)).contractStatusHistories).toHaveLength(
      signed.contractStatusHistories.length,
    );
  });

  it('거부하면 거부 사유를 함께 저장한다. 거부된 계약은 날인할 수 없다', async () => {
    const contractId = await sent();

    await prisma.$transaction((tx) =>
      rejectContract(tx, contractId, ' 근무 시간이 달라요 '),
    );
    const rejected = await stateOf(contractId);
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      rejectReason: '근무 시간이 달라요',
    });
    expect(rejected.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'PENDING_SIGNATURE',
      toStatus: 'REJECTED',
      actor: 'STAFF',
    });

    await conflictOf(prisma.$transaction((tx) => signContract(tx, contractId)));
    expect((await stateOf(contractId)).status).toBe('REJECTED');
  });

  it('날인 기한이 지나면 배치 전에도 날인을 받지 않고, 배치는 만료로 바꾼 뒤 날인을 막는다', async () => {
    const contractId = await sent(new Date(Date.now() - 60_000));

    const early = await conflictOf(
      prisma.$transaction((tx) => signContract(tx, contractId)),
    );
    expect(early.code).toBe('SIGN_DEADLINE_PASSED');
    expect((await stateOf(contractId)).status).toBe('PENDING_SIGNATURE');

    await prisma.$transaction((tx) => expiry.expireOverdue(tx));
    const expired = await stateOf(contractId);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'PENDING_SIGNATURE',
      toStatus: 'EXPIRED',
      actor: 'SYSTEM',
    });

    const late = await conflictOf(
      prisma.$transaction((tx) => signContract(tx, contractId)),
    );
    expect(late).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'EXPIRED',
    });
  });

  it('임시저장을 초안 저장으로 넘기면 상태 전환이 이력을 남긴다', async () => {
    const phone = nextPhone();
    const { contractId } = await contracts.create(
      { ...dto(phone), isTemporarySave: true },
      adminId,
    );
    await contracts.update(adminId, contractId, dto(phone));

    const saved = await stateOf(contractId);
    expect(saved.status).toBe('PENDING_SEND');
    expect(saved.contractStatusHistories.map((h) => h.toStatus)).toEqual([
      'DRAFT',
      'PENDING_SEND',
    ]);
    expect(saved.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'DRAFT',
      toStatus: 'PENDING_SEND',
      actor: 'ADMIN',
    });
  });
});
