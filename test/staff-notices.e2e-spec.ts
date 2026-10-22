import { randomInt } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { noticeStaff } from '../src/notifications/staff-notice';
import { PrismaService } from '../src/prisma/prisma.service';

// 근로계약서 발송 · 급여명세서 발송 직원 알림(#259)을 실제 DB 로 — 마이그레이션이 넣은 템플릿이 호출부가 넘기는 변수로
// 렌더되는지, 수신 설정을 끈 묶음은 앱 푸시 발송 대기가 없는지, 알림함이 눌러 열 곳(내 계약 · 내 명세서)을 주는지.
describe('직원 알림 — 근로계약서 · 급여명세서 발송 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  let accountId: number;
  let staffMemberId: number;
  const contractIds: number[] = [];
  let pendingContractId: number;
  let payslipId: number;
  let draftPayslipId: number;
  const created: number[] = [];
  let token: string;
  const logger = new Logger('staff-notices-e2e');

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
        tradeName: '직원 알림 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '모리커피 연남점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `snot${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ accountId } = await prisma.account.create({
      data: {
        email: `snot-${n}@test.invalid`,
        passwordHash: '!',
        realName: '알림',
        birthDate: new Date('1990-01-01'),
        phone: `0109${n}`.slice(0, 11),
        status: 'JOINED',
      },
    }));
    ({ staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '알림',
        phone: '01000000000',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'JOINED',
      },
    }));
    const contract = async (status: 'SIGNED' | 'PENDING_SIGNATURE') => {
      const { contractId } = await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          employmentType: 'PART_TIME',
          contractMethod: 'ELECTRONIC',
          startDate: new Date('2026-09-01'),
          isHealthPensionInsured: false,
          isEmploymentInjuryInsured: false,
          status,
          createdBy: adminId,
        },
      });
      contractIds.push(contractId);
      return contractId;
    };
    const signedId = await contract('SIGNED');
    pendingContractId = await contract('PENDING_SIGNATURE');
    // 명세서는 직원 · 기간마다 하나 — 기간을 달리한다
    const payslip = async (status: 'SENT' | 'DRAFTING', month: string) =>
      (
        await prisma.payslip.create({
          data: {
            staffMemberId,
            storeId,
            contractId: signedId,
            periodStartDate: new Date(`2026-${month}-01`),
            periodEndDate: new Date(`2026-${month}-28`),
            employmentType: 'PART_TIME',
            attendanceStartDate: new Date(`2026-${month}-01`),
            attendanceEndDate: new Date(`2026-${month}-28`),
            status,
          },
        })
      ).payslipId;
    payslipId = await payslip('SENT', '09');
    draftPayslipId = await payslip('DRAFTING', '10');

    const session = await app.get(AuthSessionService).issue({ accountId });
    token = await app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'snot@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const notifications = await prisma.notification.findMany({
      where: {
        notificationRecipients: { some: { accountId } },
      },
      select: { notificationId: true },
    });
    const ids = [...created, ...notifications.map((x) => x.notificationId)];
    await prisma.notificationDelivery.deleteMany({
      where: { notificationRecipient: { notificationId: { in: ids } } },
    });
    await prisma.notificationRecipient.deleteMany({
      where: { notificationId: { in: ids } },
    });
    await prisma.notification.deleteMany({
      where: { notificationId: { in: ids } },
    });
    await prisma.notificationPreference.deleteMany({ where: { accountId } });
    await prisma.authSession.deleteMany({ where: { accountId } });
    await prisma.payslip.deleteMany({ where: { staffMemberId } });
    await prisma.contract.deleteMany({
      where: { contractId: { in: contractIds } },
    });
    await prisma.staffMember.deleteMany({ where: { staffMemberId } });
    await prisma.account.deleteMany({ where: { accountId } });
    if (adminId !== undefined)
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: adminId },
      });
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  it('세 템플릿이 호출부 변수로 렌더되고, 수신 설정을 끈 묶음(근로계약서)은 앱 푸시 발송 대기가 없다', async () => {
    await prisma.notificationPreference.create({
      data: { accountId, preferenceCategory: 'CONTRACT', isEnabled: false },
    });
    const sent = await prisma.$transaction(async (tx) => [
      // 근로계약서 발송 — contract-delivery.service 의 noticeSent 와 같은 변수
      await noticeStaff(tx, logger, {
        templateCode: 'PUSH_CONTRACT_SENT',
        accountId,
        relatedType: 'CONTRACT',
        relatedId: pendingContractId,
        variables: { 근무지: '모리커피 연남점', 날인기한: '11월 21일' },
      }),
      // 급여명세서 발송 · 재발송 — payslip-send.service 와 같은 변수
      await noticeStaff(tx, logger, {
        templateCode: 'PUSH_PAYSLIP_SENT',
        accountId,
        relatedType: 'PAYSLIP',
        relatedId: payslipId,
        variables: { 급여월: '9월', 근무지: '모리커피 연남점' },
      }),
      await noticeStaff(tx, logger, {
        templateCode: 'PUSH_PAYSLIP_RESENT',
        accountId,
        relatedType: 'PAYSLIP',
        relatedId: draftPayslipId,
        variables: { 급여월: '9월', 근무지: '모리커피 연남점' },
      }),
    ]);
    expect(sent).toEqual([true, true, true]);

    const rows = await prisma.notificationRecipient.findMany({
      where: { accountId },
      select: {
        notification: { select: { templateCode: true, title: true } },
        notificationDeliveries: { select: { channel: true, result: true } },
      },
      orderBy: { notificationRecipientId: 'asc' },
    });
    expect(
      rows.map((r) => [
        r.notification.templateCode,
        r.notification.title,
        r.notificationDeliveries,
      ]),
    ).toEqual([
      ['PUSH_CONTRACT_SENT', '근로계약서가 도착했습니다', []],
      [
        'PUSH_PAYSLIP_SENT',
        '9월 급여명세서가 도착했습니다',
        [{ channel: 'PUSH', result: null }],
      ],
      [
        'PUSH_PAYSLIP_RESENT',
        '9월 급여명세서가 도착했습니다',
        [{ channel: 'PUSH', result: null }],
      ],
    ]);
  });

  it('알림함은 내 계약 · 내가 볼 수 있는 명세서로 갈 곳을 준다 — 발송 전 명세서는 null', async () => {
    const res = await request(app.getHttpServer())
      .get('/me/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = (
      res.body as {
        items: { templateCode: string; category: string; target: unknown }[];
      }
    ).items;
    const byCode = new Map(items.map((i) => [i.templateCode, i]));
    expect(byCode.get('PUSH_CONTRACT_SENT')).toMatchObject({
      category: 'CONTRACT',
      target: {
        type: 'CONTRACT',
        staffMemberId,
        contractId: pendingContractId,
      },
    });
    expect(byCode.get('PUSH_PAYSLIP_SENT')).toMatchObject({
      category: 'PAYSLIP',
      target: { type: 'PAYSLIP', payslipId },
    });
    expect(byCode.get('PUSH_PAYSLIP_RESENT')!.target).toBeNull();
  });
});
