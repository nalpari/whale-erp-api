import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';
import { RetirementService } from '../src/staff-members/retirement.service';
import { storeClosingCheck } from '../src/staff-members/store-closing-check';

// 폐점 확인(WHALEERP-647)을 실제 DB 로 확인한다 — 관계 조건(가입 전 임시저장만 있는 레코드 빼기, 퇴직될 직원의 계약)과
// 본사 역할에게 가려지는 직원은 첫 건 없이 수만 세는 것, 트랜잭션 안에서 부르는 것.
describe('폐점 확인 storeClosingCheck (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const today = kstToday();
  const yesterday = addDays(today, -1);
  const at = (day: Date, hh: number) =>
    new Date(kstDayStart(day).getTime() + hh * 3600_000);

  let bpCodeId: number;
  let storeId: number;
  let otherStoreId: number;
  let bmId: number;
  let sharedId: number;
  let hiddenId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];

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

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '폐점 확인 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '폐점 확인 가맹',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ storeId: otherStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 1) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '폐점 확인 다른 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const admin = async (
      loginId: string,
      roleTypeCode: string,
      roleCode: string,
      ownerBp: number,
    ) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId,
            bpCodeId: ownerBp,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId: (
              await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } })
            ).roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
          },
        })
      ).adminAccountId;
    bmId = await admin(`close${n}`, 'BM', 'BM000001', bpCodeId);

    // 가입 · 동의(보임), 가입 · 미동의(본사에게 가림) — 둘 다 어제 퇴근 없는 출근. 가린 쪽이 더 이르다
    sharedId = await staff('가동의', 'JOINED', true, [
      'SIGNED',
      'PENDING_SEND',
      'DRAFT',
    ]);
    hiddenId = await staff('나미동의', 'JOINED', false, ['SIGNED']);
    await punch(hiddenId, at(yesterday, 9));
    await punch(sharedId, at(yesterday, 11));
    // 가입 전 — 임시저장만(퇴직 대상 아님, 그 임시저장도 남는다), 서명 대기가 있음(퇴직 대상, 계약 종료)
    await staff('다임시저장만', 'INVITED', false, ['DRAFT']);
    await staff('라서명대기', 'INVITED', false, ['DRAFT', 'PENDING_SIGNATURE']);
    // 가입했고 임시저장만 — 가입했으니 퇴직 대상이고 그 임시저장도 닫힌다. 가입 전 · 계약 없음 — 퇴직 대상 아님
    await staff('바가입임시저장만', 'JOINED', false, ['DRAFT']);
    await staff('사계약없음', 'INVITED', false, []);
    // 다른 점포 — 무엇도 섞이지 않는다
    const other = await staff(
      '아다른점포',
      'JOINED',
      true,
      ['PENDING_SEND'],
      otherStoreId,
    );
    await punch(other, at(yesterday, 8), otherStoreId);
    await payslip(other, 'DRAFTING', '07', otherStoreId);
    // 이미 퇴직 — 세지 않는다
    const retired = await staff('마퇴직', 'JOINED', false, ['PENDING_SEND']);
    await prisma.staffMember.update({
      where: { staffMemberId: retired },
      data: { employmentStatus: 'RETIRED', retiredDate: addDays(today, -10) },
    });
    // 명세서 — 작성 중 · 검토 중만 센다
    for (const [month, status] of [
      ['07', 'DRAFTING'],
      ['08', 'REVIEWING'],
      ['09', 'SENT'],
    ] as const)
      await payslip(sharedId, status, month);
  });

  async function staff(
    name: string,
    joinStatus: 'JOINED' | 'INVITED',
    consented: boolean,
    statuses: ('SIGNED' | 'PENDING_SEND' | 'PENDING_SIGNATURE' | 'DRAFT')[],
    store = storeId,
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const accountId =
      joinStatus === 'JOINED'
        ? (
            await prisma.account.create({
              data: {
                email: `close-${n}@test.invalid`,
                passwordHash: '!',
                realName: name,
                birthDate: new Date('1990-01-01'),
                phone: `010${n}`,
                status: 'JOINED',
                ...(consented
                  ? {
                      isHqSharingConsented: true,
                      hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
                      hqSharingAgreedAt: new Date(),
                    }
                  : {}),
              },
            })
          ).accountId
        : null;
    if (accountId) accountIds.push(accountId);
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId: store,
        accountId,
        name,
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus,
      },
    });
    staffIds.push(staffMemberId);
    for (const status of statuses)
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId: store,
          employmentType: 'PART_TIME',
          contractMethod: 'PAPER',
          startDate: addDays(today, -30),
          isHealthPensionInsured: false,
          isEmploymentInjuryInsured: false,
          status,
          createdBy: bmId,
        },
      });
    return staffMemberId;
  }

  async function punch(
    staffMemberId: number,
    recordedAt: Date,
    store = storeId,
  ) {
    await prisma.attendanceRecord.create({
      data: {
        staffMemberId,
        storeId: store,
        kind: 'CHECK_IN',
        recordedAt,
        receivedAt: recordedAt,
      },
    });
  }

  async function payslip(
    staffMemberId: number,
    status: 'DRAFTING' | 'REVIEWING' | 'SENT',
    month: string,
    store = storeId,
  ) {
    const { contractId } = await prisma.contract.findFirstOrThrow({
      where: { staffMemberId },
    });
    const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
    await prisma.payslip.create({
      data: {
        staffMemberId,
        storeId: store,
        contractId,
        periodStartDate: d(`2026-${month}-01`),
        periodEndDate: d(`2026-${month}-28`),
        employmentType: 'PART_TIME',
        attendanceStartDate: d(`2026-${month}-01`),
        attendanceEndDate: d(`2026-${month}-28`),
        status,
        grossPayAmount: 1_000_000,
        netPayAmount: 1_000_000,
        ...(status === 'SENT' && {
          confirmedAt: new Date(),
          confirmedBy: bmId,
        }),
      },
    });
  }

  afterAll(async () => {
    if (!prisma) return;
    const records = { staffMemberId: { in: staffIds } };
    await prisma.payslip.deleteMany({ where: records });
    await prisma.attendanceRecord.deleteMany({ where: records });
    await prisma.contract.deleteMany({ where: records });
    await prisma.staffMember.deleteMany({ where: records });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    const adminIds = [bmId].filter((id) => id !== undefined);
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [storeId, otherStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  it('본사 역할에게 가려지는 직원(미동의 가맹)의 열린 출근은 첫 건으로 고르지 않고 수만 센다 · 종료될 계약 · 퇴직될 직원 · 미확정 명세서', async () => {
    const res = await storeClosingCheck(prisma, storeId, today);
    expect(res).toEqual({
      openCheckIns: {
        count: 1,
        hiddenCount: 1,
        first: {
          attendanceRecordId: expect.any(Number) as number,
          staffMemberId: sharedId,
          name: '가동의',
          recordedAt: at(yesterday, 11),
          isCheckOutExpired: false,
        },
      },
      // 가동의 · 나미동의 · 라서명대기 · 바가입임시저장만 — 다임시저장만(임시저장만 있는 가입 전)은 세지 않는다
      retiringStaff: 4,
      // 점포의 대기 계약 — 가동의 · 다임시저장만 · 라서명대기 · 바가입임시저장만의 임시저장
      draftContracts: 4,
      // 가동의 · 퇴직한 마퇴직의 발송 대기(점포 기준이라 퇴직 레코드 것도 닫힌다). 다른 점포 것은 아니다
      pendingSendContracts: 2,
      // 라서명대기의 서명 대기
      pendingSignatureContracts: 1,
      unconfirmedPayslips: 2,
    });
  });

  it('트랜잭션 안에서 불러도 같다 — 가림은 부르는 관리자와 상관없이 본사 역할 기준', async () => {
    const res = await prisma.$transaction((tx) =>
      storeClosingCheck(tx, storeId, today),
    );
    expect(res.openCheckIns).toEqual({
      count: 1,
      hiddenCount: 1,
      first: expect.objectContaining({
        staffMemberId: sharedId,
        name: '가동의',
      }) as object,
    });
  });

  it('폐점한 가맹 점포면 동의한 직원도 가려진다(v227) — 합계는 그대로 · 앱 퇴근 기한이 지난 출근', async () => {
    const stale = await prisma.attendanceRecord.create({
      data: {
        staffMemberId: sharedId,
        storeId,
        kind: 'CHECK_IN',
        recordedAt: at(addDays(today, -3), 9),
        receivedAt: at(addDays(today, -3), 9),
      },
    });
    try {
      const open = await storeClosingCheck(prisma, storeId, today);
      expect(open.openCheckIns.first).toEqual(
        expect.objectContaining({
          attendanceRecordId: stale.attendanceRecordId,
          isCheckOutExpired: true,
        }),
      );
      await prisma.store.update({
        where: { storeId },
        data: { storeStatusCode: 'CLOSED', closedDate: today },
      });
      const closed = await storeClosingCheck(prisma, storeId, today);
      expect(closed.openCheckIns).toEqual({
        count: 0,
        hiddenCount: 3,
        first: null,
      });
    } finally {
      await prisma.store.update({
        where: { storeId },
        data: { storeStatusCode: 'OPERATING', closedDate: null },
      });
      await prisma.attendanceRecord.delete({
        where: { attendanceRecordId: stale.attendanceRecordId },
      });
    }
  });

  it('퇴직될 직원 · 종료될 계약이 폐점 순간의 퇴직(retireStore)의 실제 결과와 같다 — 되돌린다', async () => {
    const rollback = new Error('되돌림');
    await expect(
      prisma.$transaction(async (tx) => {
        const check = await storeClosingCheck(tx, storeId, today);
        // retireStore 는 재직 레코드의 열린 출근이 있으면 409 로 막는다 — 확인이 알린 열린 출근을 닫은 셈 치고 지운다
        expect(check.openCheckIns.count + check.openCheckIns.hiddenCount).toBe(
          2,
        );
        await tx.attendanceRecord.deleteMany({ where: { storeId } });
        const res = await app
          .get(RetirementService)
          .retireStore(tx, storeId, today, bmId);
        expect(res).toMatchObject({
          retiringStaff: check.retiringStaff,
          draftContracts: check.draftContracts,
          pendingSendContracts: check.pendingSendContracts,
          pendingSignatureContracts: check.pendingSignatureContracts,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('없는 점포는 그대로 던진다', async () => {
    await expect(
      storeClosingCheck(prisma, 2_147_483_000, today),
    ).rejects.toThrow();
  });
});
