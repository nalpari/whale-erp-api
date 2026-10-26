import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { BizppurioClient } from './../src/alimtalk/bizppurio.client';
import { fakeBizppurio } from './fake-alimtalk';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';
import { ContractNoticeService } from '../src/contracts/contract-notice.service';
import { rejectContract, signContract } from '../src/contracts/contract-status';
import { ContractsService } from '../src/contracts/contracts.service';
import { SIGNED_ONCE } from '../src/contracts/signed-contract';
import { CreateContractDto } from '../src/contracts/dto/create-contract.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 계약 상태 전환(WHALEERP-151)을 실제 DB 로 확인한다. 조건부 UPDATE · 상태 이력 · 거부 사유가 한 트랜잭션에서
// 함께 남고, 실패하면 직전 상태가 그대로인지는 목으로 증명되지 않는다.
describe('계약 상태 전환 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let contracts: ContractsService;
  let expiry: ContractExpiryService;
  let notice: ContractNoticeService;

  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const n = randomInt(100_000, 999_999);
  let seq = 0;
  const nextPhone = () => `011${n}${String(seq++).padStart(2, '0')}`;
  /**
   * 하루 배치의 기준 시각 — 한국 시간 2000-06-01 09:00. 배치는 DB 전체를 보므로 실제 지금으로 돌리면 함께 도는 다른 스위트의
   * 계약 · 초대까지 만료 · 종료시킨다. 이 스위트의 대상만 이보다 앞선 날짜로 두고 다른 데이터는 모두 이 뒤다(api #150 리뷰).
   */
  const NOW = new Date('2000-06-01T00:00:00Z');
  const BEFORE_NOW = new Date('2000-05-01T00:00:00Z');
  /** NOW 의 한국 날짜에서 d 일 뒤(날짜 칸) */
  const day = (d: number) => new Date(Date.UTC(2000, 5, 1 + d));
  const runDaily = () => prisma.$transaction((tx) => expiry.runDaily(tx, NOW));

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
    // 근로계약 저장 · 발송이 가입 초대 알림톡을 보낸다 — 바깥 발송만 가짜로, 템플릿 렌더 · 발송 이력은 실제로 돈다(WHALEERP-616)
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BizppurioClient)
      .useValue(fakeBizppurio())
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    contracts = app.get(ContractsService);
    expiry = app.get(ContractExpiryService);
    notice = app.get(ContractNoticeService);

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
    const contractId = await sent(BEFORE_NOW);

    const early = await conflictOf(
      prisma.$transaction((tx) => signContract(tx, contractId)),
    );
    expect(early.code).toBe('SIGN_DEADLINE_PASSED');
    expect((await stateOf(contractId)).status).toBe('PENDING_SIGNATURE');

    const { expired: changed } = await runDaily();
    expect(changed.map((c) => c.contractId)).toContain(contractId);
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
  describe('하루 배치 · 관리자 알림 (WHALEERP-152 · 154)', () => {
    /** 운영 알림 행과 받는 사람 — 템플릿 변수가 틀리면 렌더러가 던져 행이 생기지 않는다(서비스는 로그만 남긴다) */
    const notificationOf = (dedupeKey: string) =>
      prisma.notification.findFirst({
        where: { dedupeKey },
        select: {
          title: true,
          body: true,
          link: true,
          relatedType: true,
          relatedId: true,
          notificationRecipients: { select: { adminAccountId: true } },
        },
      });

    it('만료한 서명 대기는 그 이력 ID 를 돌려준다', async () => {
      const contractId = await sent(BEFORE_NOW);

      const result = await runDaily();

      const mine = result.expired.find((c) => c.contractId === contractId);
      const history = await prisma.contractStatusHistory.findFirstOrThrow({
        where: { contractId, toStatus: 'EXPIRED' },
        select: { contractStatusHistoryId: true },
      });
      expect(mine?.historyId).toBe(history.contractStatusHistoryId);
    });

    it('기한이 지난 초대는 만료하지만 발송 대기 계약은 그대로라 재발송할 수 있다(api #150 리뷰)', async () => {
      const { contractId, staffMemberId } = await contracts.create(
        dto(nextPhone()),
        adminId,
      );
      await prisma.contract.update({
        where: { contractId },
        data: { signDeadlineAt: BEFORE_NOW },
      });
      await prisma.invitation.updateMany({
        where: { staffMemberId, status: 'SENT' },
        data: { expiresAt: BEFORE_NOW },
      });

      const result = await runDaily();

      expect((await stateOf(contractId)).status).toBe('PENDING_SEND');
      expect(result.expired.map((c) => c.contractId)).not.toContain(contractId);
      expect(
        await prisma.invitation.count({
          where: { staffMemberId, status: 'SENT' },
        }),
      ).toBe(0);
      expect(result.invitationsExpired).toBeGreaterThanOrEqual(1);
    });

    it('종료일이 지난 체결 완료는 종료로, 30일 안에 끝나는 체결 완료는 갱신 예정으로 한 번만 잡는다', async () => {
      const ending = await sent();
      const renewing = await sent();
      await prisma.contract.update({
        where: { contractId: ending },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(-3) },
      });
      await prisma.contract.update({
        where: { contractId: renewing },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
      });

      const first = await runDaily();
      expect(first.ended).toContain(ending);
      expect((await stateOf(ending)).status).toBe('ENDED');
      expect(first.renewalDue).toContain(renewing);
      expect((await stateOf(renewing)).status).toBe('SIGNED');

      // 다시 돌려도 같은 계약을 또 잡지 않는다 — 보낸 때를 계약에 남겼다
      const second = await runDaily();
      expect(second.renewalDue).not.toContain(renewing);
      expect(second.ended).not.toContain(ending);
    });

    it('기간이 끝나 배치가 닫은 계약은 체결을 거친 계약이다 — 체결 이력 없이 넣은 옛 계약도. 대체로 닫힌 체결 완료는 아니다(api #152 리뷰)', async () => {
      const signedOnce = (contractId: number) =>
        prisma.contract.count({ where: { contractId, ...SIGNED_ONCE } });
      // 체결 이력 없이 체결 완료가 된 옛 계약 — 종료일이 지났다
      const legacy = await sent();
      await prisma.contract.update({
        where: { contractId: legacy },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(-3) },
      });
      // 관리자가 대체로 닫은 체결 완료 — 원래 종료일이 남아 있다
      const replaced = await sent();
      await prisma.contract.update({
        where: { contractId: replaced },
        data: { status: 'ENDED', startDate: day(-40), endDate: day(300) },
      });
      await prisma.contractStatusHistory.create({
        data: {
          contractId: replaced,
          fromStatus: 'SIGNED',
          toStatus: 'ENDED',
          actor: 'ADMIN',
        },
      });

      await runDaily();

      expect((await stateOf(legacy)).status).toBe('ENDED');
      expect(await signedOnce(legacy)).toBe(1);
      expect(await signedOnce(replaced)).toBe(0);
    });

    it('종료일까지 퇴직일을 정한 직원의 체결 완료는 갱신 예정으로 잡지 않는다', async () => {
      const contractId = await sent();
      const { staffMemberId } = await prisma.contract.update({
        where: { contractId },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
        select: { staffMemberId: true },
      });
      // 퇴직 예정 — 퇴직일만 정했다
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: { retiredDate: day(5) },
      });

      const result = await runDaily();

      expect(result.renewalDue).not.toContain(contractId);
      const { renewalNotifiedAt } = await prisma.contract.findUniqueOrThrow({
        where: { contractId },
        select: { renewalNotifiedAt: true },
      });
      expect(renewalNotifiedAt).toBeNull();
    });

    it('같은 직원에게 새 계약이 진행 중이거나 더 늦게 끝나는 체결 완료가 있으면 잡지 않고, 종료일 뒤 퇴직일이면 잡는다', async () => {
      const renewing = await sent();
      const { staffMemberId } = await prisma.contract.update({
        where: { contractId: renewing },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
        select: { staffMemberId: true },
      });
      // 같은 직원 레코드에 다음 계약을 이미 써 두었다(임시저장)
      const next = await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          status: 'DRAFT',
          createdBy: adminId,
        },
        select: { contractId: true },
      });
      // 다음 계약도 30일 안에 끝나지만 이 계약보다 늦다 — 이미 갱신했다(범위 끝이 아니라 이 계약의 종료일과 견준다)
      const renewed = await sent();
      const r = await prisma.contract.update({
        where: { contractId: renewed },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
        select: { staffMemberId: true },
      });
      const following = await prisma.contract.create({
        data: {
          staffMemberId: r.staffMemberId,
          storeId,
          status: 'SIGNED',
          startDate: day(11),
          endDate: day(20),
          createdBy: adminId,
        },
        select: { contractId: true },
      });
      // 퇴직일이 종료일 뒤(30일 범위 안) — 계약이 끝나도 계속 일한다
      const laterRetiring = await sent();
      const later = await prisma.contract.update({
        where: { contractId: laterRetiring },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
        select: { staffMemberId: true },
      });
      await prisma.staffMember.update({
        where: { staffMemberId: later.staffMemberId },
        data: { retiredDate: day(15) },
      });

      const result = await runDaily();

      expect(result.renewalDue).not.toContain(renewing);
      expect(result.renewalDue).not.toContain(renewed);
      expect(result.renewalDue).toContain(laterRetiring);
      await prisma.contract.deleteMany({
        where: {
          contractId: { in: [next.contractId, following.contractId] },
        },
      });
    });

    it('만료 · 날인 · 거부 · 갱신 예정 알림이 실제 템플릿으로 운영 알림을 만들고, 같은 사건은 한 번만이다', async () => {
      const contractId = await sent();
      const today = new Date();
      await prisma.contract.update({
        where: { contractId },
        data: {
          rejectReason: '근무 시간이 달라요',
          endDate: new Date(
            Date.UTC(
              today.getUTCFullYear(),
              today.getUTCMonth(),
              today.getUTCDate() + 20,
            ),
          ),
        },
      });

      for (const [event, historyId] of [
        ['EXPIRED', 900_001],
        ['SIGNED', 900_002],
        ['REJECTED', 900_003],
      ] as const)
        await notice.statusChanged(event, contractId, historyId + n);
      await notice.renewalDue(contractId);

      const expired = await notificationOf(
        `NTF_CONTRACT_EXPIRED:${900_001 + n}`,
      );
      expect(expired).toMatchObject({
        title: '남도현 님의 근로계약서가 날인 기한이 지나 만료되었습니다',
        link: `/contracts/${contractId}`,
        relatedType: 'CONTRACT',
        relatedId: contractId,
      });
      // 직영 점포 · 전체 점포를 맡은 BP 관리자가 받는다(storeManagers)
      expect(
        expired?.notificationRecipients.map((r) => r.adminAccountId),
      ).toContain(adminId);
      expect(
        await notificationOf(`NTF_CONTRACT_SIGNED:${900_002 + n}`),
      ).not.toBeNull();
      expect(
        (await notificationOf(`NTF_CONTRACT_REJECTED:${900_003 + n}`))?.body,
      ).toContain('근무 시간이 달라요');
      expect(
        (await notificationOf(`NTF_CONTRACT_RENEWAL_DUE:${contractId}`))?.title,
      ).toMatch(/^남도현 님의 근로계약이 \d+월 \d+일에 끝납니다$/);

      // 같은 사건(같은 이력 ID)은 두 번 알리지 않는다
      await notice.statusChanged('EXPIRED', contractId, 900_001 + n);
      expect(
        await prisma.notification.count({
          where: { dedupeKey: `NTF_CONTRACT_EXPIRED:${900_001 + n}` },
        }),
      ).toBe(1);
    });
  });
});
