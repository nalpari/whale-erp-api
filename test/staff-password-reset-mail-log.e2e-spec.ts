import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { MailPasswordResetLinkSender } from '../src/auth/mail-password-reset-link.sender';
import { PasswordResetLinkSender } from '../src/auth/password-reset-link-sender';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MAIL_SEND_FAILURE_MESSAGE } from '../src/staff-members/send-logs';
import type { StaffMemberSendLogResponseDto } from '../src/staff-members/dto/staff-member-summary.response.dto';

// 실제 MailService(템플릿 · 발송 이력)에 SMTP 만 바꿔 끼워, 관리자 초기화 → 직원 상세 발송 이력(WHALEERP-676)을 본다.
describe('직원 비밀번호 초기화 메일 발송 이력 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sendMail = jest.fn();
  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  let adminToken: string;
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  const contractIds: number[] = [];
  const mailIds: number[] = [];

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    process.env.STAFF_APP_URL = 'https://staff.test.invalid';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PasswordResetLinkSender)
      .useFactory({
        inject: [PrismaService],
        factory: (p: PrismaService) =>
          new MailPasswordResetLinkSender(
            new MailService({ sendMail }, { username: 'test@test.invalid' }, p),
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '메일 이력 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '메일 이력 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `mlog${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    adminToken = (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: adminId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: adminId,
            type: 'admin',
            loginId: `admin${adminId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  });

  beforeEach(() =>
    sendMail.mockReset().mockResolvedValue({ messageId: 'test' }),
  );

  afterAll(async () => {
    await prisma.mailSendLog.deleteMany({
      where: {
        OR: [
          { staffMemberId: { in: staffIds } },
          { mailId: { in: mailIds } },
          { sentBy: adminId },
        ],
      },
    });
    await prisma.passwordResetLink.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.contractStatusHistory.deleteMany({
      where: { contractId: { in: contractIds } },
    });
    await prisma.contract.deleteMany({
      where: { contractId: { in: contractIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  async function createStaff() {
    const n = randomInt(10_000_000, 99_999_999);
    const account = await prisma.account.create({
      data: {
        email: `mlog-${n}@test.invalid`,
        passwordHash: '!',
        realName: '홍길동',
        birthDate: new Date('1990-01-01'),
        phone: `010${n}`,
        status: 'JOINED',
      },
    });
    accountIds.push(account.accountId);
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        accountId: account.accountId,
        name: '홍길동',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'JOINED',
      },
    });
    staffIds.push(staff.staffMemberId);
    return { staffMemberId: staff.staffMemberId, accountId: account.accountId };
  }

  const api = () => request(app.getHttpServer());
  const auth = { Authorization: () => `Bearer ${adminToken}` };
  const reset = (staffMemberId: number) =>
    api()
      .post(`/staff-members/${staffMemberId}/password-reset-links`)
      .set('Authorization', auth.Authorization());
  const sendLogs = (staffMemberId: number) =>
    api()
      .get(`/staff-members/${staffMemberId}/summary/send-logs`)
      .set('Authorization', auth.Authorization());

  it('초기화 메일을 보내면 그 직원의 발송 이력에 PASSWORD_RESET 줄이 생기고, 이력 행에 직원 계정 id · 직원 id · 요청 관리자가 남는다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await reset(staffMemberId).expect(201);

    const res = await sendLogs(staffMemberId).expect(200);
    const { items } = res.body as StaffMemberSendLogResponseDto;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'PASSWORD_RESET',
      contractId: null,
      isResend: false,
      result: 'SUCCEEDED',
      failureReason: null,
      retryable: null,
    });
    const row = await prisma.mailSendLog.findFirstOrThrow({
      where: { staffMemberId },
    });
    expect(row).toMatchObject({
      mailTypeCode: 'EMAIL_STAFF_RESET_LINK',
      accountId,
      staffMemberId,
      sentBy: adminId,
      result: 'SUCCEEDED',
    });
    expect(row.body).not.toContain('#token=');
  });

  it('SMTP 가 실패하면 FAILED 줄과 고정 문구만 보이고 SMTP 원문 · 받는 주소는 새지 않는다', async () => {
    const { staffMemberId } = await createStaff();
    sendMail.mockRejectedValue(
      Object.assign(
        new Error('550 mailbox unavailable <secret@test.invalid>'),
        {
          code: 'EENVELOPE',
          responseCode: 550,
        },
      ),
    );
    await reset(staffMemberId).expect(503);

    const res = await sendLogs(staffMemberId).expect(200);
    const { items } = res.body as StaffMemberSendLogResponseDto;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'PASSWORD_RESET',
      result: 'FAILED',
      failureReason: MAIL_SEND_FAILURE_MESSAGE,
      retryable: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('test.invalid');
    // 원문은 이력 행에만 있다
    const row = await prisma.mailSendLog.findFirstOrThrow({
      where: { staffMemberId },
    });
    expect(row.failureReason).toContain('EENVELOPE');
  });

  it('메일 이력이 있는 직원 레코드가 계약 삭제로 지워져도 성공하고, 이력 행은 남고 직원 칸만 비워진다(ON DELETE SET NULL)', async () => {
    // 가입 전(DRAFT) 직원 + 작성 중 계약 — DELETE /contracts/:id 가 계약이 없어진 가입 전 직원 레코드를 지운다
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '가입 전',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: 'DRAFT',
      },
    });
    staffIds.push(staff.staffMemberId);
    const contract = await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        createdBy: adminId,
        status: 'DRAFT',
      },
    });
    contractIds.push(contract.contractId);
    const { mailId } = await prisma.mailSendLog.create({
      data: {
        mailTypeCode: 'EMAIL_STAFF_RESET_LINK',
        staffMemberId: staff.staffMemberId,
        fromEmail: 'noreply@test.invalid',
        toEmail: 'gone@test.invalid',
        subject: 's',
        body: '-',
        result: 'SUCCEEDED',
      },
    });

    mailIds.push(mailId);
    await api()
      .delete(`/contracts/${contract.contractId}`)
      .set('Authorization', auth.Authorization())
      .expect(204);

    expect(
      await prisma.staffMember.count({
        where: { staffMemberId: staff.staffMemberId },
      }),
    ).toBe(0);
    const row = await prisma.mailSendLog.findUniqueOrThrow({
      where: { mailId },
    });
    expect(row.staffMemberId).toBeNull();
  });
});
