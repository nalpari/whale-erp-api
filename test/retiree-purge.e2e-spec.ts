import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { BATCH_JOB } from '../src/batch/batch-job-names';
import { BatchLockService } from '../src/batch/batch-lock.service';
import { ContractPurgeService } from '../src/contracts/contract-purge';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, addMonths, kstToday } from '../src/staff-members/kst-date';
import {
  purgeRetiredAccountChanges,
  purgeRetiredTaxProfiles,
} from '../src/staff-members/retiree-purge';
import { STORAGE } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';

// 퇴직자 근로계약 · 신고 정보 · 계정 변경 이력 파기(WHALEERP-645)를 실제 DB 로 확인한다 — 외래키(모두 RESTRICT)가 지우는
// 순서를 막지 않는지, 급여명세서가 가리키는 레코드는 건너뛰는지, 퇴직일 + 3년 당일 · 퇴직 예정은 남는지. 목으로는 쿼리
// 모양만 보인다.
describe('퇴직자 보존 기간 파기 (e2e, DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };

  const now = new Date();
  const today = kstToday(now);
  /** 오늘이 퇴직일 + 3년 당일인 퇴직일 — 남는다 */
  const edgeRetired = addMonths(today, -36);
  /** 하루 더 지난 퇴직일 — 지운다 */
  const expiredRetired = addDays(edgeRetired, -1);

  let storeId: number;
  const n = randomInt(100_000, 999_999);
  let seq = 0;

  const account = async () =>
    (
      await prisma.account.create({
        data: {
          email: `purge-${n}-${++seq}@test.invalid`,
          passwordHash: '!',
          realName: '홍길동',
          birthDate: new Date('1990-01-01'),
          phone: `010${n}${seq}`,
          status: 'JOINED',
        },
      })
    ).accountId;
  const staff = async (
    accountId: number | null,
    retiredDate: Date,
    employmentStatus: 'RETIRED' | 'EMPLOYED' = 'RETIRED',
  ) =>
    (
      await prisma.staffMember.create({
        data: {
          storeId,
          accountId,
          name: '홍길동',
          phone: '01000000000',
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          employmentStatus,
          joinStatus: 'JOINED',
          retiredDate,
        },
      })
    ).staffMemberId;
  const contract = async (staffMemberId: number, previousContractId?: number) =>
    (
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          previousContractId,
          status: 'EXPIRED',
          startDate: addMonths(expiredRetired, -12),
          endDate: expiredRetired,
          createdBy: 1,
        },
      })
    ).contractId;
  const taxProfile = async (staffMemberId: number, accountId: number) => {
    await prisma.staffTaxProfile.create({
      data: {
        staffMemberId,
        rrnEncrypted: Buffer.from('x'),
        bankCode: '004',
        payrollAccountNumberEncrypted: Buffer.from('y'),
        purpose: '취득 신고',
      },
    });
    await prisma.staffTaxProfileHistory.create({
      data: { staffMemberId, field: 'RRN', accountId },
    });
  };
  const notice = async (
    relatedType: string,
    relatedId: number,
    accountId: number,
  ) => {
    const { notificationId } = await prisma.notification.create({
      data: {
        notificationTarget: 'STAFF',
        templateCode: 'NTF_TEST',
        relatedType,
        relatedId,
        title: '알림',
        body: '홍길동',
      },
    });
    const { notificationRecipientId } =
      await prisma.notificationRecipient.create({
        data: { notificationId, accountId },
      });
    await prisma.notificationDelivery.create({
      data: { notificationRecipientId, channel: 'PUSH', result: 'SUCCEEDED' },
    });
    return notificationId;
  };

  beforeAll(async () => {
    // 이 파일은 DB 전체에 파기 배치를 돌린다 — 공용 DB 에서 돌면 남의 자료를 지운다. 일회용 DB 를 명시해야만 돈다.
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const { bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '파기 테스트 BP',
      },
    });
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '파기 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('퇴직일 + 3년이 지난 레코드의 계약 · 딸린 행 · 파일 · 근무스케줄 · 알림과 신고 정보, 계정의 휴대전화번호 · 주소 이력을 지운다', async () => {
    // 지울 레코드 — 계정 A 의 유일한 소속
    const accountA = await account();
    const expired = await staff(accountA, expiredRetired);
    const first = await contract(expired);
    const renewal = await contract(expired, first);
    // 파기는 저장소 키 형식(newKey)이 아닌 파일이 있는 레코드를 미룬다 — 실제 키 모양으로 만든다
    const firstKey = StorageService.newKey('contracts', first, 'PDF');
    const renewalKey = StorageService.newKey('contracts', renewal, 'PDF');
    await prisma.contractDocument.createMany({
      data: [
        {
          contractId: first,
          kind: 'PAPER_EMPLOYMENT_CONTRACT',
          storageKey: firstKey,
          fileName: 'a.pdf',
          checksum: 'a',
        },
        {
          contractId: renewal,
          kind: 'WAGE_CONTRACT',
          storageKey: renewalKey,
          fileName: 'b.pdf',
          checksum: 'b',
        },
      ],
    });
    await prisma.contractStatusHistory.create({
      data: { contractId: first, toStatus: 'SIGNED', actor: 'STAFF' },
    });
    await prisma.contractParty.create({ data: { contractId: first } });
    await prisma.contractWorkDay.create({
      data: {
        contractId: first,
        weekday: 'MON',
        startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    const { workScheduleId } = await prisma.workSchedule.create({
      data: {
        staffMemberId: expired,
        storeId,
        startAt: new Date('2023-01-02T00:00:00Z'),
        endAt: new Date('2023-01-02T04:00:00Z'),
        sourceContractId: first,
        createdBy: 1,
      },
    });
    await prisma.workScheduleHistory.create({
      data: { workScheduleId, changeType: 'CREATED', changedBy: 1 },
    });
    const scheduleNotice = await notice(
      'WORK_SCHEDULE',
      workScheduleId,
      accountA,
    );
    const contractNotice = await notice('CONTRACT', renewal, accountA);
    const { staffMemberRetirementLogId } =
      await prisma.staffMemberRetirementLog.create({
        data: {
          staffMemberId: expired,
          action: 'RETIRE',
          retiredDate: expiredRetired,
          contractId: renewal,
          // 종료일이 있으면 연결만 비울 수 없다(CHECK end_date_needs_contract) — 함께 비우는지 본다
          previousContractEndDate: expiredRetired,
          processedBy: 1,
        },
      });
    const { alimtalkSendLogId } = await prisma.alimtalkSendLog.create({
      data: {
        templateCode: 'CONTRACT_SENT',
        kakaoTemplateCode: 'k',
        toPhone: '01000000000',
        relatedType: 'contract',
        relatedId: first,
        body: '홍길동',
        result: 'SUCCEEDED',
        referenceKey: `purge-${n}`,
      },
    });
    await taxProfile(expired, accountA);
    await prisma.accountChangeHistory.createMany({
      data: (['PHONE', 'ADDRESS', 'EMAIL'] as const).map((field) => ({
        accountId: accountA,
        field,
        channel: 'SELF' as const,
      })),
    });

    // 남을 레코드 — 계정 B 는 오늘이 + 3년 당일인 소속과 지난 소속(명세서 있음)이 있다
    const accountB = await account();
    const edge = await staff(accountB, edgeRetired);
    const edgeContract = await contract(edge, first); // 다른 레코드가 지울 계약을 직전 계약으로 가리킨다
    await taxProfile(edge, accountB);
    const paid = await staff(accountB, expiredRetired);
    const paidContract = await contract(paid);
    await prisma.payslip.create({
      data: {
        staffMemberId: paid,
        storeId,
        contractId: paidContract,
        periodStartDate: addMonths(expiredRetired, -1),
        periodEndDate: expiredRetired,
        employmentType: 'PART_TIME',
        attendanceStartDate: addMonths(expiredRetired, -1),
        attendanceEndDate: expiredRetired,
      },
    });
    await taxProfile(paid, accountB);
    await prisma.accountChangeHistory.create({
      data: { accountId: accountB, field: 'PHONE', channel: 'SELF' },
    });
    // 퇴직 예정(재직) — 퇴직일이 지났어도 확정 전이면 남는다
    const planned = await staff(null, expiredRetired, 'EMPLOYED');
    const plannedContract = await contract(planned);
    // 소속이 없는 계정의 이력은 남는다
    const accountC = await account();
    await prisma.accountChangeHistory.create({
      data: { accountId: accountC, field: 'ADDRESS', channel: 'SELF' },
    });

    const lock = app.get(BatchLockService);
    const contracts = await lock.runExclusive(BATCH_JOB.CONTRACT_PURGE, (tx) =>
      app.get(ContractPurgeService).purgeRetiredContracts(tx, now),
    );
    const taxes = await lock.runExclusive(BATCH_JOB.TAX_PROFILE_PURGE, (tx) =>
      purgeRetiredTaxProfiles(tx, now),
    );
    const changes = await lock.runExclusive(
      BATCH_JOB.ACCOUNT_CHANGE_PURGE,
      (tx) => purgeRetiredAccountChanges(tx, now),
    );

    // 건수는 일회용 DB 에 앞선 실행이 남긴 행까지 센다 — 아래에서 이 테스트의 행으로 본다
    expect(contracts.ran).toBe(true);
    expect(storage.delete).toHaveBeenCalledWith(firstKey, {
      thumbnail: false,
    });
    expect(storage.delete).toHaveBeenCalledWith(renewalKey, {
      thumbnail: false,
    });
    const gone = { contractId: { in: [first, renewal] } };
    expect(await prisma.contract.count({ where: gone })).toBe(0);
    expect(await prisma.contractDocument.count({ where: gone })).toBe(0);
    expect(await prisma.contractStatusHistory.count({ where: gone })).toBe(0);
    expect(await prisma.contractParty.count({ where: gone })).toBe(0);
    expect(await prisma.contractWorkDay.count({ where: gone })).toBe(0);
    expect(await prisma.workSchedule.count({ where: { workScheduleId } })).toBe(
      0,
    );
    expect(
      await prisma.workScheduleHistory.count({ where: { workScheduleId } }),
    ).toBe(0);
    const notices = {
      notificationId: { in: [scheduleNotice, contractNotice] },
    };
    expect(await prisma.notification.count({ where: notices })).toBe(0);
    expect(await prisma.notificationRecipient.count({ where: notices })).toBe(
      0,
    );
    // 연결만 비우고 남는 것 · 그대로 두는 것
    expect(
      await prisma.staffMemberRetirementLog.findUniqueOrThrow({
        where: { staffMemberRetirementLogId },
      }),
    ).toMatchObject({ contractId: null, previousContractEndDate: null });
    expect(
      await prisma.contract.findUniqueOrThrow({
        where: { contractId: edgeContract },
      }),
    ).toMatchObject({ previousContractId: null });
    expect(
      await prisma.alimtalkSendLog.count({ where: { alimtalkSendLogId } }),
    ).toBe(1);
    expect(
      await prisma.staffMember.count({ where: { staffMemberId: expired } }),
    ).toBe(1);
    // 명세서가 가리키는 레코드 · 퇴직 예정은 계약이 남는다
    expect(
      await prisma.contract.count({
        where: { contractId: { in: [paidContract, plannedContract] } },
      }),
    ).toBe(2);

    // 신고 정보 — 지난 레코드는 명세서와 상관없이 지우고, + 3년 당일은 남는다
    expect(taxes.ran).toBe(true);
    expect(
      await prisma.staffTaxProfile.findMany({
        where: { staffMemberId: { in: [expired, edge, paid] } },
        select: { staffMemberId: true },
      }),
    ).toEqual([{ staffMemberId: edge }]);
    expect(
      await prisma.staffTaxProfileHistory.count({
        where: { staffMemberId: { in: [expired, paid] } },
      }),
    ).toBe(0);

    // 계정 변경 이력 — A 의 휴대전화번호 · 주소만, B(+ 3년 당일 소속) · C(소속 없음)는 남는다
    expect(changes.ran).toBe(true);
    expect(
      await prisma.accountChangeHistory.findMany({
        where: { accountId: { in: [accountA, accountB, accountC] } },
        select: { accountId: true, field: true },
        orderBy: { accountId: 'asc' },
      }),
    ).toEqual([
      { accountId: accountA, field: 'EMAIL' },
      { accountId: accountB, field: 'PHONE' },
      { accountId: accountC, field: 'ADDRESS' },
    ]);

    // 다시 돌려도 지울 것이 없다(멱등)
    await expect(
      lock.runExclusive(BATCH_JOB.CONTRACT_PURGE, (tx) =>
        app.get(ContractPurgeService).purgeRetiredContracts(tx, now),
      ),
    ).resolves.toEqual({ ran: true, processed: 0 });
  });
});
