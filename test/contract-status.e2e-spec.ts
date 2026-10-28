import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { BizppurioClient } from './../src/alimtalk/bizppurio.client';
import { fakeBizppurio } from './fake-alimtalk';
import { STORAGE } from './../src/storage/storage.module';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';
import { ContractNoticeService } from '../src/contracts/contract-notice.service';
import { rejectContract, signContract } from '../src/contracts/contract-status';
import { ContractsService } from '../src/contracts/contracts.service';
import { ContractSendService } from '../src/contracts/contract-send.service';
import { SIGNED_ONCE } from '../src/contracts/signed-contract';
import { StaffMemberSummaryService } from '../src/staff-members/staff-member-summary.service';
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
      // 종이 계약 날인본 — 저장소는 가짜로, 계약 · 문서 행은 실제 DB 에 남는다(WHALEERP-156 종이 계약 겹침)
      .overrideProvider(STORAGE)
      .useValue({
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      })
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

  describe('재계약 (WHALEERP-156)', () => {
    /** 체결 완료 계약 하나 — 번호 · 직원 레코드와 함께 */
    const signedContract = async () => {
      const phone = nextPhone();
      const { contractId, staffMemberId } = await contracts.create(
        dto(phone),
        adminId,
      );
      await prisma.contract.update({
        where: { contractId },
        data: { status: 'SIGNED', startDate: day(-40), endDate: day(10) },
      });
      return { phone, contractId, staffMemberId };
    };
    const renew = (phone: string, previousContractId: number) =>
      contracts.create(
        { ...dto(phone), startDate: '2026-12-01', previousContractId },
        adminId,
      );

    it('가입한 재직 직원에게는 직전 계약을 고르지 않아도 새 계약이 그 레코드의 재계약이다 — 같은 레코드 · 앱으로 서명 대기(WHALEERP-130)', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();
      const { accountId } = await prisma.account.create({
        data: {
          email: `renew-${n}-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          gender: 'MALE',
          status: 'JOINED',
        },
        select: { accountId: true },
      });
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: { joinStatus: 'JOINED', accountId },
      });

      // 직전 계약 없이 보낸다 — 그 직원의 최근 체결 계약에 잇는다
      const renewed = await contracts.create(
        { ...dto(phone), startDate: '2026-12-01' },
        adminId,
      );
      expect(renewed).toMatchObject({
        staffMemberId,
        status: 'PENDING_SIGNATURE',
        draftAction: 'IMMEDIATE_SEND',
      });
      const saved = await prisma.contract.findUniqueOrThrow({
        where: { contractId: renewed.contractId },
        select: { previousContractId: true },
      });
      expect(saved.previousContractId).toBe(contractId);
      // 앞 계약은 그대로 체결 완료다 — 새 계약 시작일에 배치가 닫는다
      expect((await stateOf(contractId)).status).toBe('SIGNED');
      // 진행 중인 재계약이 있으면 또 보낼 때 대체를 묻는다(같은 점포 진행 중 계약과 같다)
      await expect(
        contracts.create({ ...dto(phone), startDate: '2026-12-01' }, adminId),
      ).rejects.toThrow('진행 중인 근로계약이 있습니다');
    });

    it('재계약이 아닌 임시저장 · 거부 계약은 그대로 최근 계약이다 — 직전 계약이 없는 계약을 빼지 않는다(api #157 code-review)', async () => {
      const { contractId, staffMemberId } = await contracts.create(
        { ...dto(nextPhone()), isTemporarySave: true },
        adminId,
      );
      const { contract } = await app
        .get(StaffMemberSummaryService)
        .contract(adminId, staffMemberId);
      expect(contract).toMatchObject({ contractId, status: 'DRAFT' });
    });

    it('거부된 재계약은 직원 상세의 최근 계약으로 서지 않는다 — 지금 효력인 직전 계약이 보인다(api #157 셀프 리뷰)', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();
      const renewed = await renew(phone, contractId);
      await prisma.contract.update({
        where: { contractId: renewed.contractId },
        data: { status: 'REJECTED' },
      });

      const { contract } = await app
        .get(StaffMemberSummaryService)
        .contract(adminId, staffMemberId);

      expect(contract).toMatchObject({ contractId, status: 'SIGNED' });

      // 체결 없이 종료된 재계약(발송 대기 종료 · 대체)도 건너뛴다(api #157 리뷰)
      await prisma.contract.update({
        where: { contractId: renewed.contractId },
        data: { status: 'ENDED' },
      });
      const after = await app
        .get(StaffMemberSummaryService)
        .contract(adminId, staffMemberId);
      expect(after.contract).toMatchObject({ contractId, status: 'SIGNED' });
    });

    it('재계약을 저장 · 날인해도 시작 전이면 직원의 직무 · 고용 형태는 그대로고, 시작일에 하루 배치가 옮긴다(WHALEERP-156)', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();
      const record = () =>
        prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId },
          select: { jobTitle: true, employmentType: true },
        });
      const before = await record();

      // 직무 · 고용 형태를 바꾼 재계약 — 저장만으로는 직원 레코드가 바뀌지 않는다
      const renewed = await contracts.create(
        {
          ...dto(phone),
          jobTitle: '매니저',
          employmentType: 'FULL_TIME',
          startDate: '2026-12-01',
          previousContractId: contractId,
        },
        adminId,
      );
      expect(await record()).toEqual(before);
      const saved = await prisma.contract.findUniqueOrThrow({
        where: { contractId: renewed.contractId },
        select: { jobTitle: true, employmentType: true },
      });
      expect(saved).toEqual({
        jobTitle: '매니저',
        employmentType: 'FULL_TIME',
      });
      // 계약 상세는 그 계약에 적은 직무를 보인다
      expect(
        (await contracts.findOne(adminId, renewed.contractId)).jobTitle,
      ).toBe('매니저');

      // 미리 체결했다(시작 전) — 아직 그대로
      await prisma.contract.update({
        where: { contractId: renewed.contractId },
        data: { status: 'SIGNED', startDate: day(1) },
      });
      await runDaily();
      expect(await record()).toEqual(before);

      // 시작일이 되면 배치가 옮긴다
      await prisma.contract.update({
        where: { contractId: renewed.contractId },
        data: { startDate: day(0) },
      });
      await runDaily();
      expect(await record()).toEqual({
        jobTitle: '매니저',
        employmentType: 'FULL_TIME',
      });
    });

    it('체결을 거친 계약이 있는 레코드는 다른 계약을 이어 써도 직무 · 고용 형태가 바뀌지 않는다 — 배치와 오가지 않게(api #157 code-review)', async () => {
      const phone = nextPhone();
      const draft = await contracts.create(
        { ...dto(phone), isTemporarySave: true },
        adminId,
      );
      const record = () =>
        prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId: draft.staffMemberId },
          select: { jobTitle: true, employmentType: true },
        });
      await prisma.contract.create({
        data: {
          staffMemberId: draft.staffMemberId,
          storeId,
          status: 'SIGNED',
          startDate: day(-40),
          jobTitle: '바리스타',
          employmentType: 'PART_TIME',
          createdBy: adminId,
        },
      });

      await contracts.update(adminId, draft.contractId, {
        ...dto(phone),
        isTemporarySave: true,
        jobTitle: '매니저',
        employmentType: 'FULL_TIME',
      });

      expect(await record()).toEqual({
        jobTitle: '바리스타',
        employmentType: 'PART_TIME',
      });
      await runDaily();
      expect(await record()).toEqual({
        jobTitle: '바리스타',
        employmentType: 'PART_TIME',
      });
    });

    it('하루 배치는 기간이 끝나 닫힌 계약도 지금 조건으로 본다 — 더 늦게 시작했으면 옛 체결 완료로 덮지 않는다(api #157 code-review)', async () => {
      const { contractId, staffMemberId } = await signedContract();
      await prisma.contract.update({
        where: { contractId },
        data: { startDate: day(-200), endDate: null, jobTitle: '바리스타' },
      });
      const later = await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          status: 'ENDED',
          startDate: day(-100),
          endDate: day(-1),
          jobTitle: '매니저',
          employmentType: 'FULL_TIME',
          createdBy: adminId,
        },
      });
      await prisma.contractStatusHistory.create({
        data: {
          contractId: later.contractId,
          fromStatus: 'SIGNED',
          toStatus: 'ENDED',
          actor: 'SYSTEM',
        },
      });

      await runDaily();

      expect(
        await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId },
          select: { jobTitle: true, employmentType: true },
        }),
      ).toEqual({ jobTitle: '매니저', employmentType: 'FULL_TIME' });
    });

    it('가입 전 직원(종이 계약 체결)의 재계약도 같은 레코드에 붙는다', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();

      const renewed = await renew(phone, contractId);

      expect(renewed.staffMemberId).toBe(staffMemberId);
      expect(renewed.status).toBe('PENDING_SEND');
    });

    it('가입 전 직원(종이 계약 체결)에게 직전 계약 없이 같은 이름으로 보내도 재계약이다 — 앞 계약이 시작일에 닫히게(WHALEERP-130)', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();

      const renewed = await contracts.create(
        { ...dto(phone), startDate: '2026-12-01' },
        adminId,
      );

      expect(renewed.staffMemberId).toBe(staffMemberId);
      const saved = await prisma.contract.findUniqueOrThrow({
        where: { contractId: renewed.contractId },
        select: { previousContractId: true },
      });
      expect(saved.previousContractId).toBe(contractId);
    });

    it('퇴직한 직원의 재계약은 재입사라 새 레코드를 만들고 직전 레코드 · 계약을 잇는다', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();
      await prisma.contract.update({
        where: { contractId },
        data: { status: 'ENDED' },
      });
      // 체결된 뒤 종료됐다(SIGNED_ONCE)
      await prisma.contractStatusHistory.createMany({
        data: [
          {
            contractId,
            fromStatus: 'PENDING_SIGNATURE',
            toStatus: 'SIGNED',
            actor: 'STAFF',
          },
          {
            contractId,
            fromStatus: 'SIGNED',
            toStatus: 'ENDED',
            actor: 'SYSTEM',
          },
        ],
      });
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: { employmentStatus: 'RETIRED', retiredDate: day(-1) },
      });

      const renewed = await renew(phone, contractId);

      expect(renewed.staffMemberId).not.toBe(staffMemberId);
      const record = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: renewed.staffMemberId },
        select: { previousStaffMemberId: true },
      });
      expect(record.previousStaffMemberId).toBe(staffMemberId);
      const saved = await prisma.contract.findUniqueOrThrow({
        where: { contractId: renewed.contractId },
        select: { previousContractId: true },
      });
      expect(saved.previousContractId).toBe(contractId);
    });

    it('재계약 임시저장은 이어 쓰기에서 번호를 바꿀 수 없고, 가입한 직원이면 이어 써 보낼 때 판별 없이 앱으로 서명 대기다', async () => {
      const { phone, contractId, staffMemberId } = await signedContract();
      const { accountId } = await prisma.account.create({
        data: {
          email: `renew-put-${n}-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          gender: 'MALE',
          status: 'JOINED',
        },
        select: { accountId: true },
      });
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: { joinStatus: 'JOINED', accountId },
      });
      const draft = await contracts.create(
        {
          ...dto(phone),
          startDate: '2026-12-01',
          previousContractId: contractId,
          isTemporarySave: true,
        },
        adminId,
      );
      expect(draft).toMatchObject({ staffMemberId, status: 'DRAFT' });

      await expect(
        contracts.update(adminId, draft.contractId, {
          ...dto(nextPhone()),
          startDate: '2026-12-01',
        }),
      ).rejects.toThrow(
        '재계약은 직전 계약과 같은 휴대전화번호로만 할 수 있습니다',
      );

      await expect(
        contracts.update(adminId, draft.contractId, {
          ...dto(phone),
          startDate: '2026-12-01',
        }),
      ).resolves.toMatchObject({
        staffMemberId,
        status: 'PENDING_SIGNATURE',
        draftAction: 'IMMEDIATE_SEND',
      });
      expect((await stateOf(contractId)).status).toBe('SIGNED');
    });

    it('재계약이 체결됐으면 다시 재계약할 수 없고, 진행 중이면 대체를 묻는다 — 거부된 재계약은 치지 않는다', async () => {
      const { phone, contractId } = await signedContract();
      const first = await renew(phone, contractId);
      // 진행 중 재계약 — 대체 확인(409 CONTRACT_IN_PROGRESS)
      await expect(renew(phone, contractId)).rejects.toThrow(
        '진행 중인 근로계약이 있습니다',
      );

      await prisma.contract.update({
        where: { contractId: first.contractId },
        data: { status: 'REJECTED' },
      });
      const second = await renew(phone, contractId);
      expect(second.status).toBe('PENDING_SEND');

      // 체결된 재계약이 있으면 막는다 — 한 계약에서 체결 완료가 둘 생기지 않게
      await prisma.contract.update({
        where: { contractId: second.contractId },
        data: { status: 'SIGNED' },
      });
      await expect(renew(phone, contractId)).rejects.toThrow(
        '이미 재계약해 체결한 근로계약입니다',
      );
    });

    it('체결 전 계약 · 다른 번호로는 재계약할 수 없다', async () => {
      const pending = await sent();
      const { phone } = await prisma.contract
        .findUniqueOrThrow({
          where: { contractId: pending },
          select: { staffMember: { select: { phone: true } } },
        })
        .then((c) => c.staffMember);
      await expect(renew(phone, pending)).rejects.toThrow(
        '체결 완료되었거나 체결 뒤 종료된 근로계약만 재계약할 수 있습니다',
      );

      const { contractId } = await signedContract();
      await expect(renew(nextPhone(), contractId)).rejects.toThrow(
        '재계약은 직전 계약과 같은 휴대전화번호로만 할 수 있습니다',
      );
    });

    describe('재계약 시작일 · 종이 계약 겹침 (2026-10-26 김민식 · 재영 확인)', () => {
      const utc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
      /** 2026-11-01 ~ 2027-10-31 체결 완료 계약(가입 전 직원) */
      const signedFrom = async () => {
        const signed = await signedContract();
        await prisma.contract.update({
          where: { contractId: signed.contractId },
          data: { startDate: utc('2026-11-01'), endDate: utc('2027-10-31') },
        });
        return signed;
      };
      const paperDocs = [
        {
          kind: 'PAPER_EMPLOYMENT_CONTRACT' as const,
          fileName: '근로계약서.pdf',
          buffer: Buffer.from('%PDF-1.7'),
          fileType: 'PDF' as const,
        },
      ];
      const paper = (phone: string, over: Partial<CreateContractDto>) =>
        contracts.create(
          { ...dto(phone), contractMethod: 'PAPER', ...over },
          adminId,
          paperDocs,
        );
      const codeOf = (e: unknown) =>
        (e as HttpException).getResponse() as {
          code?: string;
          contracts?: { contractId: number }[];
        };

      it('재계약 시작일이 직전 계약 시작일과 같으면 400, 하루 뒤부터는 직전 계약과 겹쳐도 저장되고 앞 계약은 그대로다', async () => {
        const { phone, contractId } = await signedFrom();
        await expect(
          contracts.create(
            {
              ...dto(phone),
              startDate: '2026-11-01',
              previousContractId: contractId,
            },
            adminId,
          ),
        ).rejects.toThrow(
          '재계약 시작일은 직전 계약 시작일(2026-11-01) 다음 날부터입니다',
        );

        const renewed = await contracts.create(
          {
            ...dto(phone),
            startDate: '2026-11-02',
            previousContractId: contractId,
          },
          adminId,
        );
        expect(renewed.status).toBe('PENDING_SEND');
        expect((await stateOf(contractId)).status).toBe('SIGNED');
      });

      it('종이 계약 재계약은 직전 계약과 겹쳐도 대체하지 않고 체결 완료로 등록한다 — 앞 계약은 시작일에 배치가 닫는다', async () => {
        const { phone, contractId, staffMemberId } = await signedFrom();

        const renewed = await paper(phone, {
          startDate: '2027-05-01',
          previousContractId: contractId,
        });

        expect(renewed).toMatchObject({ staffMemberId, status: 'SIGNED' });
        expect((await stateOf(contractId)).status).toBe('SIGNED');
      });

      it('같은 계약서를 다시 올리면 409 SIGNED_CONTRACT_OVERLAP 이고, 잘못 올린 계약 바로잡기로 다시 보내면 앞 계약을 곧바로 종료한다', async () => {
        const { phone, contractId } = await signedFrom();
        const again = { startDate: '2026-11-01', endDate: '2027-10-31' };

        // 직전 계약을 고르지 않은 같은 시작일 — 재계약이 아니라 같은 계약서를 다시 올린 것으로 본다
        const error = await paper(phone, again).catch((e: unknown) => e);
        expect(codeOf(error)).toMatchObject({
          code: 'SIGNED_CONTRACT_OVERLAP',
          contracts: [{ contractId }],
        });
        expect((await stateOf(contractId)).status).toBe('SIGNED');

        const corrected = await paper(phone, {
          ...again,
          correctSignedContracts: true,
          replaceContractIds: [contractId],
        });
        expect(corrected.status).toBe('SIGNED');
        const closed = await stateOf(contractId);
        expect(closed.status).toBe('ENDED');
        // 사유는 받지 않는다 — 관리자가 체결 완료에서 종료로 바꾼 이력으로 남는다
        expect(closed.contractStatusHistories.at(-1)).toEqual({
          fromStatus: 'SIGNED',
          toStatus: 'ENDED',
          actor: 'ADMIN',
        });
      });

      it('잘못 올린 재계약을 바로잡아도 겹치지 않는 직전 계약은 닫지 않는다 — 배치가 시작일에 닫는다(api #157 리뷰 블로커 1)', async () => {
        const { phone, contractId } = await signedFrom();
        // 직전 계약(2026-11-01 ~ 2027-10-31) 뒤에 이어지는 재계약 — 잘못 올렸다
        const wrong = await paper(phone, {
          startDate: '2027-11-01',
          previousContractId: contractId,
        });
        // 같은 계약서를 다시 올림(직전 계약 없이 같은 시작일) — 겹치는 것은 잘못 올린 재계약뿐이다
        const again = { startDate: '2027-11-01' };
        const error = await paper(phone, again).catch((e: unknown) => e);
        expect(codeOf(error)).toMatchObject({
          code: 'SIGNED_CONTRACT_OVERLAP',
          contracts: [{ contractId: wrong.contractId }],
        });

        await paper(phone, {
          ...again,
          correctSignedContracts: true,
          replaceContractIds: [wrong.contractId],
        });
        expect((await stateOf(wrong.contractId)).status).toBe('ENDED');
        expect((await stateOf(contractId)).status).toBe('SIGNED');
      });

      it.each([false, true])(
        '잘못 올린 재계약은 바로잡기로 그 재계약만 닫고, 다시 올린 계약이 직전 계약을 잇는다 — 가입 직원(%s)도(api #157 리뷰)',
        async (joinedStaff) => {
          const { phone, contractId, staffMemberId } = await signedFrom();
          if (joinedStaff) {
            const { accountId } = await prisma.account.create({
              data: {
                email: `fix-${n}-${phone}@test.invalid`,
                passwordHash: '!',
                realName: '남도현',
                birthDate: new Date('1998-07-12'),
                phone,
                gender: 'MALE',
                status: 'JOINED',
              },
              select: { accountId: true },
            });
            await prisma.staffMember.update({
              where: { staffMemberId },
              data: { joinStatus: 'JOINED', accountId },
            });
          }
          // 직전 계약(2026-11-01 ~ 2027-10-31) 기간 안에서 시작하는 재계약 — 내용이 틀렸다
          const wrong = await paper(phone, {
            startDate: '2027-05-01',
            previousContractId: contractId,
          });
          // 같은 계약서를 다시 올림 — 409 목록에는 잘못 올린 재계약만(직전 계약은 빠진다)
          const again = { startDate: '2027-05-01' };
          const error = await paper(phone, again).catch((e: unknown) => e);
          expect(codeOf(error)).toMatchObject({
            code: 'SIGNED_CONTRACT_OVERLAP',
            contracts: [{ contractId: wrong.contractId }],
          });

          const fixed = await paper(phone, {
            ...again,
            correctSignedContracts: true,
            replaceContractIds: [wrong.contractId],
          });
          expect(fixed.staffMemberId).toBe(staffMemberId);
          expect((await stateOf(wrong.contractId)).status).toBe('ENDED');
          expect((await stateOf(contractId)).status).toBe('SIGNED');
          const saved = await prisma.contract.findUniqueOrThrow({
            where: { contractId: fixed.contractId },
            select: { previousContractId: true },
          });
          expect(saved.previousContractId).toBe(contractId);
        },
      );

      it('C1 기간 안에서 시작한 조기 재계약 C2 의 종이 재계약은 C1 때문에 막히지 않는다 — 줄의 앞 계약은 배치가 닫는다(api #157 셀프 code-review)', async () => {
        const { phone, contractId: c1 } = await signedFrom();
        const c2 = await paper(phone, {
          startDate: '2027-05-01',
          previousContractId: c1,
        });

        const c3 = await paper(phone, {
          startDate: '2027-08-01',
          previousContractId: c2.contractId,
        });
        expect(c3.status).toBe('SIGNED');
        expect((await stateOf(c1)).status).toBe('SIGNED');
        expect((await stateOf(c2.contractId)).status).toBe('SIGNED');
      });

      it('C2 가 C1 기간 안에서 시작해도 C3 바로잡기는 C1 을 닫지 않는다 — 대체 대상을 정한 뒤 직전 계약을 뺀다(api #157 재리뷰 5 블로커)', async () => {
        const { phone, contractId: c1, staffMemberId } = await signedFrom();
        // C1(2026-11-01 ~ 2027-10-31) 기간 안에서 시작하는 조기 재계약 C2
        const c2 = await paper(phone, {
          startDate: '2027-05-01',
          previousContractId: c1,
        });
        // C2 의 재계약 C3 — 전자계약으로 날인해 체결 완료(종이 계약 겹침 검사를 거치지 않는 길), 내용이 틀렸다
        const c3 = await prisma.contract.create({
          data: {
            staffMemberId,
            storeId,
            status: 'SIGNED',
            contractMethod: 'ELECTRONIC',
            startDate: utc('2027-08-01'),
            previousContractId: c2.contractId,
            createdBy: adminId,
          },
        });
        const again = { startDate: '2027-08-01' };
        const error = await paper(phone, again).catch((e: unknown) => e);
        expect(codeOf(error)).toMatchObject({
          code: 'SIGNED_CONTRACT_OVERLAP',
          contracts: [{ contractId: c3.contractId }],
        });

        const fixed = await paper(phone, {
          ...again,
          correctSignedContracts: true,
          replaceContractIds: [c3.contractId],
        });
        expect((await stateOf(c3.contractId)).status).toBe('ENDED');
        expect((await stateOf(c2.contractId)).status).toBe('SIGNED');
        expect((await stateOf(c1)).status).toBe('SIGNED');
        const saved = await prisma.contract.findUniqueOrThrow({
          where: { contractId: fixed.contractId },
          select: { previousContractId: true },
        });
        expect(saved.previousContractId).toBe(c2.contractId);
      });

      it('잘못 올린 재계약을 닫으면 직원 정보의 직무를 지금 효력인 계약으로 되돌린다(api #157 재리뷰 5 참고 3)', async () => {
        // 지금 효력인 C1(이미 시작, 바리스타)
        const { phone, contractId, staffMemberId } = await signedContract();
        const record = () =>
          prisma.staffMember.findUniqueOrThrow({
            where: { staffMemberId },
            select: { jobTitle: true },
          });
        // 잘못 올린 재계약 W(이미 시작, 점장) — 등록하면서 직원 정보로 옮겨졌다
        const wrong = await paper(phone, {
          startDate: '2026-10-01',
          jobTitle: '점장',
          previousContractId: contractId,
        });
        expect(await record()).toEqual({ jobTitle: '점장' });

        // 바로 쓴 계약서(아직 시작 전, 매니저)로 바로잡는다 — 날짜가 지나도 시작 전이게 먼 앞날
        await paper(phone, {
          startDate: '2099-12-01',
          jobTitle: '매니저',
          correctSignedContracts: true,
          replaceContractIds: [wrong.contractId],
        });
        expect((await stateOf(wrong.contractId)).status).toBe('ENDED');
        // 닫힌 W 의 점장이 남지 않고 지금 효력인 C1 의 바리스타 — 매니저는 시작일에 옮긴다
        expect(await record()).toEqual({ jobTitle: '바리스타' });
      });

      it('재입사한 가입 직원의 잘못 올린 재계약도 POST 바로잡기로 그 레코드에 다시 올린다(api #157 재리뷰 5 참고 4)', async () => {
        // 퇴직한 옛 레코드의 C1(종료일 없음 — 아직 체결 완료)
        const {
          phone,
          contractId: c1,
          staffMemberId: retired,
        } = await signedContract();
        await prisma.contract.update({
          where: { contractId: c1 },
          data: { endDate: null },
        });
        await prisma.staffMember.update({
          where: { staffMemberId: retired },
          data: { employmentStatus: 'RETIRED', retiredDate: day(-1) },
        });
        // 재입사 레코드(가입함)의 재입사 재계약 W — C1 을 잇는다, 내용이 틀렸다
        const reentry = await contracts.create(
          { ...dto(phone), isTemporarySave: true },
          adminId,
        );
        const { accountId } = await prisma.account.create({
          data: {
            email: `reentry-${n}-${phone}@test.invalid`,
            passwordHash: '!',
            realName: '남도현',
            birthDate: new Date('1998-07-12'),
            phone,
            gender: 'MALE',
            status: 'JOINED',
          },
          select: { accountId: true },
        });
        await prisma.staffMember.update({
          where: { staffMemberId: reentry.staffMemberId },
          data: { joinStatus: 'JOINED', accountId },
        });
        await prisma.contract.update({
          where: { contractId: reentry.contractId },
          data: {
            status: 'SIGNED',
            contractMethod: 'PAPER',
            startDate: utc('2026-10-01'),
            previousContractId: c1,
          },
        });

        const fixed = await paper(phone, {
          startDate: '2026-10-01',
          correctSignedContracts: true,
          replaceContractIds: [reentry.contractId],
        });
        expect(fixed).toMatchObject({
          staffMemberId: reentry.staffMemberId,
          status: 'SIGNED',
        });
        expect((await stateOf(reentry.contractId)).status).toBe('ENDED');
        expect((await stateOf(c1)).status).toBe('SIGNED');
        const saved = await prisma.contract.findUniqueOrThrow({
          where: { contractId: fixed.contractId },
          select: { previousContractId: true },
        });
        expect(saved.previousContractId).toBe(c1);
      });

      it('이어 쓰기 바로잡기는 대체되는 재계약이 다른 레코드의 것이면 409 — 재입사 재계약이어도(api #157 재리뷰 4 참고 3)', async () => {
        // 퇴직한 옛 레코드의 C1
        const {
          phone,
          contractId: c1,
          staffMemberId: retired,
        } = await signedContract();
        await prisma.staffMember.update({
          where: { staffMemberId: retired },
          data: { employmentStatus: 'RETIRED', retiredDate: day(-1) },
        });
        // 재입사 레코드의 재입사 재계약 W(C1 을 잇는다)
        const reentry = await contracts.create(
          { ...dto(phone), isTemporarySave: true },
          adminId,
        );
        expect(reentry.staffMemberId).not.toBe(retired);
        await prisma.contract.update({
          where: { contractId: reentry.contractId },
          data: {
            status: 'SIGNED',
            contractMethod: 'PAPER',
            startDate: utc('2026-10-01'),
            previousContractId: c1,
          },
        });
        // 같은 번호의 다른 사람(다른 레코드) 임시저장
        const other = await contracts.create(
          { ...dto(phone), name: '남도연', isTemporarySave: true },
          adminId,
        );
        expect(other.staffMemberId).not.toBe(reentry.staffMemberId);

        await expect(
          contracts.update(
            adminId,
            other.contractId,
            {
              ...dto(phone),
              name: '남도연',
              contractMethod: 'PAPER',
              startDate: '2026-10-01',
              correctSignedContracts: true,
              replaceContractIds: [reentry.contractId],
            },
            paperDocs,
          ),
        ).rejects.toThrow('잘못 올린 재계약은 그 직원의 근로계약으로');
        expect((await stateOf(reentry.contractId)).status).toBe('SIGNED');
      });

      it('두 번째 재계약도 바로잡는다 — C1 → C2 → C3 에서 C3 만 닫고 다시 올린 계약이 C2 를 잇는다(api #157 재리뷰 4 블로커)', async () => {
        const { phone, contractId: c1, staffMemberId } = await signedFrom();
        // C1(2026-11-01 ~ 2027-10-31) 다음에 이어지는 C2
        const c2 = await paper(phone, {
          startDate: '2027-11-01',
          previousContractId: c1,
        });
        // C2 의 재계약 — 내용이 틀렸다
        const c3 = await paper(phone, {
          startDate: '2028-03-01',
          previousContractId: c2.contractId,
        });
        const again = { startDate: '2028-03-01' };
        const error = await paper(phone, again).catch((e: unknown) => e);
        expect(codeOf(error)).toMatchObject({
          code: 'SIGNED_CONTRACT_OVERLAP',
          contracts: [{ contractId: c3.contractId }],
        });

        const fixed = await paper(phone, {
          ...again,
          correctSignedContracts: true,
          replaceContractIds: [c3.contractId],
        });
        expect(fixed.staffMemberId).toBe(staffMemberId);
        expect((await stateOf(c3.contractId)).status).toBe('ENDED');
        expect((await stateOf(c2.contractId)).status).toBe('SIGNED');
        expect((await stateOf(c1)).status).toBe('SIGNED');
        const saved = await prisma.contract.findUniqueOrThrow({
          where: { contractId: fixed.contractId },
          select: { previousContractId: true },
        });
        expect(saved.previousContractId).toBe(c2.contractId);
      });

      it('가입한 재직 직원의 잘못 올린 첫 계약도 바로잡기로 고친다 — 같은 레코드에 다시 올린다(api #157 재리뷰 3 · 4 참고)', async () => {
        const { phone, contractId, staffMemberId } = await signedFrom();
        const { accountId } = await prisma.account.create({
          data: {
            email: `fix1-${n}-${phone}@test.invalid`,
            passwordHash: '!',
            realName: '남도현',
            birthDate: new Date('1998-07-12'),
            phone,
            gender: 'MALE',
            status: 'JOINED',
          },
          select: { accountId: true },
        });
        // 잘못 올린 계약(2026-11-01 시작, 바리스타)이 입사일 · 직무를 정해 두었다
        await prisma.staffMember.update({
          where: { staffMemberId },
          data: {
            joinStatus: 'JOINED',
            accountId,
            hiredDate: utc('2026-11-01'),
            jobTitle: '바리스타',
          },
        });
        // 바로 쓴 계약서 — 2026-10-30 시작(아직 시작 전, 잘못 올린 계약보다 앞이라 다시 올린 것으로 본다), 매니저
        const again = {
          startDate: '2026-10-30',
          endDate: '2027-10-31',
          jobTitle: '매니저',
        };
        const error = await paper(phone, again).catch((e: unknown) => e);
        expect(codeOf(error)).toMatchObject({
          code: 'SIGNED_CONTRACT_OVERLAP',
          contracts: [{ contractId }],
        });

        const fixed = await paper(phone, {
          ...again,
          correctSignedContracts: true,
          replaceContractIds: [contractId],
        });
        expect(fixed).toMatchObject({ staffMemberId, status: 'SIGNED' });
        expect((await stateOf(contractId)).status).toBe('ENDED');
        // 닫힌 계약의 입사일 · 직무가 남지 않는다 — 효력인 계약이 남지 않아 다시 올린 계약 값(api #157 code-review)
        expect(
          await prisma.staffMember.findUniqueOrThrow({
            where: { staffMemberId },
            select: { hiredDate: true, jobTitle: true },
          }),
        ).toEqual({ hiredDate: utc('2026-10-30'), jobTitle: '매니저' });
      });

      it('더 늦게 체결한 계약이 있는데 옛 계약에서 재계약하면 409 — 지금 체결 완료와 새 계약이 함께 남지 않게', async () => {
        const { phone, contractId, staffMemberId } = await signedFrom();
        await prisma.contract.create({
          data: {
            staffMemberId,
            storeId,
            status: 'SIGNED',
            startDate: utc('2027-11-01'),
            createdBy: adminId,
          },
        });
        await expect(
          contracts.create(
            {
              ...dto(phone),
              startDate: '2027-12-01',
              previousContractId: contractId,
            },
            adminId,
          ),
        ).rejects.toThrow('더 최근에 체결한 근로계약이 있습니다');
      });

      it('직전 계약이 아닌 체결 완료와 기간이 겹치면 막고, 겹치지 않으면 그대로 둔 채 등록한다', async () => {
        const { phone, contractId } = await signedFrom();
        // 이름이 달라 재계약으로 잇지 않는다 — 같은 번호의 다른 사람 계약
        const other = { name: '남도연' };

        const error = await paper(phone, {
          ...other,
          startDate: '2027-03-01',
        }).catch((e: unknown) => e);
        expect(codeOf(error).code).toBe('SIGNED_CONTRACT_OVERLAP');

        const saved = await paper(phone, {
          ...other,
          startDate: '2027-11-01',
        });
        expect(saved.status).toBe('SIGNED');
        expect((await stateOf(contractId)).status).toBe('SIGNED');

        // 재계약이 직전 계약이 아닌 그 체결 완료(종료일 없음)와 겹치면 바로잡기를 안내하지 않고 막기만 한다 — 재계약과 바로잡기는
        // 함께 쓸 수 없다(api #157 셀프 리뷰)
        const renewal = await paper(phone, {
          startDate: '2027-12-01',
          previousContractId: contractId,
        }).catch((e: unknown) => e);
        expect(codeOf(renewal).code).toBe('RENEWAL_SIGNED_OVERLAP');
        expect((await stateOf(contractId)).status).toBe('SIGNED');
      });
    });

    it('이어지는 계약이 체결 완료이고 시작일이 되면 하루 배치가 앞 계약을 종료로 바꾼다 — 종료일은 그대로', async () => {
      const started = await signedContract();
      const next = await renew(started.phone, started.contractId);
      await prisma.contract.update({
        where: { contractId: next.contractId },
        data: { status: 'SIGNED', startDate: day(0) },
      });
      const waiting = await signedContract();
      const later = await renew(waiting.phone, waiting.contractId);
      await prisma.contract.update({
        where: { contractId: later.contractId },
        data: { status: 'SIGNED', startDate: day(1) },
      });

      const result = await runDaily();

      expect(result.ended).toContain(started.contractId);
      const ended = await prisma.contract.findUniqueOrThrow({
        where: { contractId: started.contractId },
        select: { status: true, endDate: true },
      });
      expect(ended).toEqual({ status: 'ENDED', endDate: day(10) });
      // 아직 시작 전이면 그대로
      expect(result.ended).not.toContain(waiting.contractId);
      expect((await stateOf(waiting.contractId)).status).toBe('SIGNED');
    });
  });

  describe('거부 · 만료 재발송 (WHALEERP-153)', () => {
    it('가입 전 직원의 거부 계약은 가입 초대로 다시 보내 발송 대기가 되고, 이력 · 재발송 횟수가 남는다', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) =>
        rejectContract(tx, contractId, '시급이 달라요'),
      );

      const result = await app
        .get(ContractSendService)
        .send(adminId, contractId);

      expect(result.status).toBe('PENDING_SEND');
      const after = await prisma.contract.findUniqueOrThrow({
        where: { contractId },
        select: { status: true, resendCount: true, staffMemberId: true },
      });
      expect(after).toMatchObject({ status: 'PENDING_SEND', resendCount: 1 });
      expect(
        (await stateOf(contractId)).contractStatusHistories.at(-1),
      ).toEqual({
        fromStatus: 'REJECTED',
        toStatus: 'PENDING_SEND',
        actor: 'ADMIN',
      });
      expect(
        await prisma.invitation.count({
          where: { staffMemberId: after.staffMemberId, status: 'SENT' },
        }),
      ).toBe(1);
    });

    it('같은 사람의 체결 완료 계약이 따로 있으면 거부 계약을 되살리지 않고, 상세의 재발송 버튼도 숨긴다(api #158 code-review)', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) => rejectContract(tx, contractId, null));
      const { staffMemberId } = await prisma.contract.findUniqueOrThrow({
        where: { contractId },
        select: { staffMemberId: true },
      });
      // 같은 레코드에 새로 체결된 계약
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          status: 'SIGNED',
          startDate: day(0),
          createdBy: adminId,
        },
      });

      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        false,
      );
      await expect(
        app.get(ContractSendService).send(adminId, contractId),
      ).rejects.toThrow('체결 완료된 근로계약이 있습니다');
      expect((await stateOf(contractId)).status).toBe('REJECTED');
    });

    it('겹치지 않아도 더 늦게 시작한 체결 완료가 있으면 되살리지 않는다 — 먼저 끝난 체결 완료는 막지 않는다(api #158 code-review)', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) => rejectContract(tx, contractId, null));
      const { staffMemberId } = await prisma.contract.update({
        where: { contractId },
        data: {
          startDate: new Date('2026-11-01'),
          endDate: new Date('2027-01-31'),
        },
        select: { staffMemberId: true },
      });
      const earlier = await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          status: 'SIGNED',
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-10-31'),
          createdBy: adminId,
        },
      });
      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        true,
      );

      await prisma.contract.update({
        where: { contractId: earlier.contractId },
        data: {
          startDate: new Date('2027-03-01'),
          endDate: new Date('2027-08-31'),
        },
      });
      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        false,
      );
      await expect(
        app.get(ContractSendService).send(adminId, contractId),
      ).rejects.toThrow('체결 완료된 근로계약이 있습니다');
    });

    it('시작일이 빈 거부 계약도 상세가 열리고, 다른 체결 완료가 있으면 기간을 몰라 되살리지 않는다(api #158 code-review)', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) => rejectContract(tx, contractId, null));
      const { staffMemberId } = await prisma.contract.update({
        where: { contractId },
        data: { startDate: null },
        select: { staffMemberId: true },
      });
      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        true,
      );

      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          status: 'SIGNED',
          startDate: new Date('2020-01-01'),
          endDate: new Date('2020-12-31'),
          createdBy: adminId,
        },
      });
      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        false,
      );
      await expect(
        app.get(ContractSendService).send(adminId, contractId),
      ).rejects.toThrow('체결 완료된 근로계약이 있습니다');
    });

    it('계약 기간이 끝난 거부 계약은 되살리지 않는다(api #158 code-review)', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) => rejectContract(tx, contractId, null));
      await prisma.contract.update({
        where: { contractId },
        data: {
          startDate: new Date('2020-01-01'),
          endDate: new Date('2020-12-31'),
        },
      });

      expect((await contracts.findOne(adminId, contractId)).canResend).toBe(
        false,
      );
      await expect(
        app.get(ContractSendService).send(adminId, contractId),
      ).rejects.toThrow('계약 기간이 끝난 근로계약서는 다시 보낼 수 없습니다');
    });

    it('상세의 마지막 발송 시각을 그대로 보내면 다시 보내고, 그 낡은 값으로 또 보내면 409 — 두 탭 재발송(api #158 셀프 code-review)', async () => {
      const contractId = await sent();
      const seen = (await contracts.findOne(adminId, contractId)).lastSentAt;
      expect(seen).not.toBeNull();
      const send = () =>
        app.get(ContractSendService).send(adminId, contractId, new Date(), {
          status: 'PENDING_SIGNATURE',
          sentAt: seen as string,
        });

      await send();
      await expect(send()).rejects.toThrow(
        '다른 요청이 먼저 근로계약서를 다시 보냈습니다',
      );
    });

    it('서명 대기로 본 화면에서 보내면 그사이 거부된 계약을 되살리지 않는다 — 409 CONTRACT_STATUS_CONFLICT(front #136 재리뷰)', async () => {
      const contractId = await sent();
      await prisma.$transaction((tx) => rejectContract(tx, contractId, null));

      await expect(
        app.get(ContractSendService).send(adminId, contractId, new Date(), {
          status: 'PENDING_SIGNATURE',
        }),
      ).rejects.toThrow('화면을 새로 고쳐');
      expect((await stateOf(contractId)).status).toBe('REJECTED');
    });

    it('가입한 직원의 만료 계약은 서명 대기 · 새 기한으로 다시 보내고 다시 날인할 수 있다', async () => {
      const contractId = await sent(BEFORE_NOW);
      await runDaily();
      expect((await stateOf(contractId)).status).toBe('EXPIRED');
      const { staffMemberId, staffMember } =
        await prisma.contract.findUniqueOrThrow({
          where: { contractId },
          select: {
            staffMemberId: true,
            staffMember: { select: { phone: true } },
          },
        });
      const { accountId } = await prisma.account.create({
        data: {
          email: `resend-${n}-${staffMember.phone}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone: staffMember.phone,
          gender: 'MALE',
          status: 'JOINED',
        },
        select: { accountId: true },
      });
      await prisma.staffMember.update({
        where: { staffMemberId },
        data: { joinStatus: 'JOINED', accountId },
      });

      const result = await app
        .get(ContractSendService)
        .send(adminId, contractId);

      expect(result.status).toBe('PENDING_SIGNATURE');
      expect(new Date(result.signDeadlineAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      await prisma.$transaction((tx) => signContract(tx, contractId));
      expect((await stateOf(contractId)).status).toBe('SIGNED');
    });
  });
});
