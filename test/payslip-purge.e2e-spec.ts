import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { BATCH_JOB } from '../src/batch/batch-job-names';
import { BatchLockService } from '../src/batch/batch-lock.service';
import { ContractPurgeService } from '../src/contracts/contract-purge';
import { purgeExpiredPayslips } from '../src/payslips/payslip-purge';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addDays,
  addMonths,
  kstDayStart,
  kstToday,
} from '../src/staff-members/kst-date';
import { STORAGE } from '../src/storage/storage.module';

// 급여명세서 보존 기간 파기(WHALEERP-649)를 실제 DB 로 확인한다 — 딸린 행 · 알림을 지우는 순서를 외래키(모두 RESTRICT)가 막지
// 않는지, 생성일 + 3년 당일은 남는지, 계정이 탈퇴해도 같은 기준인지, 명세서가 없어진 뒤 퇴직자 계약 파기(645)가 건너뛰던
// 레코드를 지우는지.
describe('급여명세서 보존 기간 파기 (e2e, DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const now = new Date();
  const today = kstToday(now);
  /** 이 순간부터 만든 것은 남는다(생성일 + 3년 당일) */
  const cutoff = kstDayStart(addMonths(today, -36));
  const expiredRetired = addDays(addMonths(today, -36), -1);
  const n = randomInt(100_000, 999_999);
  let storeId: number;

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
      .useValue({ delete: jest.fn().mockResolvedValue(undefined) })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const { bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '명세서 파기 BP',
      },
    });
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '명세서 파기 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
  });

  afterAll(async () => {
    await app?.close();
  });

  /** 퇴직일 + 3년이 지난 퇴직 레코드와 그 계약 하나 */
  const retiredWithContract = async (accountStatus: 'JOINED' | 'WITHDRAWN') => {
    const { accountId } = await prisma.account.create({
      data: {
        email: `payslip-purge-${n}-${accountStatus.toLowerCase()}@test.invalid`,
        passwordHash: '!',
        realName: '홍길동',
        birthDate: new Date('1990-01-01'),
        phone: `010${n}${accountStatus === 'JOINED' ? 1 : 2}`,
        status: accountStatus,
      },
    });
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '홍길동',
        phone: '01000000000',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        employmentStatus: 'RETIRED',
        joinStatus: 'JOINED',
        retiredDate: expiredRetired,
      },
    });
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        status: 'EXPIRED',
        startDate: addMonths(expiredRetired, -12),
        endDate: expiredRetired,
        createdBy: 1,
      },
    });
    return { accountId, staffMemberId, contractId };
  };

  /** 명세서와 딸린 행 · 알림 — createdAt 에 만들었다 */
  const payslipWithRows = async (
    owner: { accountId: number; staffMemberId: number; contractId: number },
    createdAt: Date,
    month: number,
  ) => {
    const start = addMonths(expiredRetired, -month);
    const { payslipId } = await prisma.payslip.create({
      data: {
        staffMemberId: owner.staffMemberId,
        storeId,
        contractId: owner.contractId,
        periodStartDate: start,
        periodEndDate: addDays(start, 27),
        employmentType: 'PART_TIME',
        attendanceStartDate: start,
        attendanceEndDate: addDays(start, 27),
        createdAt,
      },
    });
    const master = await prisma.payslipItemMaster.findFirstOrThrow();
    await prisma.payslipItem.create({
      data: {
        payslipId,
        itemCategory: 'EARNING',
        payslipItemMasterId: master.payslipItemMasterId,
        itemName: '기본급',
      },
    });
    await prisma.payslipReviewReason.create({
      data: { payslipId, reviewReason: 'MISSING_ATTENDANCE' },
    });
    await prisma.payslipDispatch.create({
      data: { payslipId, channel: 'PUSH', status: 'SUCCEEDED' },
    });
    await prisma.payslipLog.create({
      data: { payslipId, logType: 'SEND', summary: '발송' },
    });
    const { notificationId } = await prisma.notification.create({
      data: {
        notificationTarget: 'STAFF',
        templateCode: 'NTF_TEST',
        relatedType: 'PAYSLIP',
        relatedId: payslipId,
        title: '급여명세서',
        body: '홍길동',
      },
    });
    const { notificationRecipientId } =
      await prisma.notificationRecipient.create({
        data: { notificationId, accountId: owner.accountId },
      });
    await prisma.notificationDelivery.create({
      data: { notificationRecipientId, channel: 'PUSH', result: 'SUCCEEDED' },
    });
    return { payslipId, notificationId };
  };

  it('명세서를 가리키는 외래키는 파기가 먼저 지우는 네 표뿐이다 — 새 표가 생기면 파기에 넣어야 한다(빠지면 배치가 날마다 같은 자리에서 실패한다)', async () => {
    const rows = await prisma.$queryRaw<{ table: string }[]>`
      SELECT conrelid::regclass::text AS table FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'payslips'::regclass
      ORDER BY 1
    `;
    expect(rows.map((r) => r.table)).toEqual([
      'payslip_dispatches',
      'payslip_items',
      'payslip_logs',
      'payslip_review_reasons',
    ]);
  });

  it('생성일 + 3년이 지난 명세서를 딸린 행 · 알림과 함께 지우고(당일은 남김, 탈퇴 계정도 같음), 다음 계약 파기가 건너뛰던 레코드를 지운다', async () => {
    const withdrawn = await retiredWithContract('WITHDRAWN');
    const expired = await payslipWithRows(
      withdrawn,
      new Date(cutoff.getTime() - 60_000),
      1,
    );
    // 다른 레코드의 생성일 + 3년 당일 명세서 — 남고, 그 레코드의 계약도 남는다
    const kept = await retiredWithContract('JOINED');
    const edge = await payslipWithRows(kept, cutoff, 1);
    // 지운 명세서와 related_id 만 같은 다른 종류 알림 — 남는다
    const { notificationId: otherKind } = await prisma.notification.create({
      data: {
        notificationTarget: 'STAFF',
        templateCode: 'NTF_TEST',
        relatedType: 'CONTRACT',
        relatedId: expired.payslipId,
        title: '근로계약',
        body: '홍길동',
      },
    });

    const lock = app.get(BatchLockService);
    const purgeContracts = () =>
      lock.runExclusive(BATCH_JOB.CONTRACT_PURGE, (tx) =>
        app.get(ContractPurgeService).purgeRetiredContracts(tx, now),
      );
    const contractOf = (contractId: number) =>
      prisma.contract.findUnique({ where: { contractId } });

    // 명세서가 있는 동안 계약 파기는 그 레코드를 건너뛴다
    await purgeContracts();
    expect(await contractOf(withdrawn.contractId)).not.toBeNull();

    const result = await lock.runExclusive(BATCH_JOB.PAYSLIP_PURGE, (tx) =>
      purgeExpiredPayslips(tx, now),
    );
    expect(result.ran).toBe(true);
    const gone = { payslipId: expired.payslipId };
    expect(await prisma.payslip.findUnique({ where: gone })).toBeNull();
    for (const count of [
      prisma.payslipItem.count({ where: gone }),
      prisma.payslipReviewReason.count({ where: gone }),
      prisma.payslipDispatch.count({ where: gone }),
      prisma.payslipLog.count({ where: gone }),
      prisma.notification.count({
        where: { notificationId: expired.notificationId },
      }),
      prisma.notificationRecipient.count({
        where: { notificationId: expired.notificationId },
      }),
      prisma.notificationDelivery.count({
        where: {
          notificationRecipient: { notificationId: expired.notificationId },
        },
      }),
    ])
      expect(await count).toBe(0);
    const left = { payslipId: edge.payslipId };
    expect(await prisma.payslip.findUnique({ where: left })).not.toBeNull();
    expect(await prisma.payslipItem.count({ where: left })).toBe(1);
    expect(
      await prisma.notification.count({
        where: { notificationId: { in: [edge.notificationId, otherKind] } },
      }),
    ).toBe(2);
    await prisma.notification.delete({
      where: { notificationId: otherKind },
    });

    // 같은 날 05:00 계약 파기 — 명세서가 없어진 레코드의 계약을 지운다. 명세서가 남은 레코드는 그대로 건너뛴다
    await purgeContracts();
    expect(await contractOf(withdrawn.contractId)).toBeNull();
    expect(await contractOf(kept.contractId)).not.toBeNull();
  });
});
