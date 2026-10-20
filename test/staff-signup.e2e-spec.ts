import { randomBytes, randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { hashToken } from '../src/auth/password';
import {
  hashInvitationCode,
  newInvitationCode,
} from '../src/contracts/contract-delivery.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';
import { HQ_SHARING_CONSENT_VERSION } from '../src/staff-signup/hq-sharing-consent';

// 직원 앱 진입 · 가입(WHALEERP-601, 진입 · 가입 화면 가이드 JOIN-7)을 실제 DB 로 확인한다. 초대 수락 · 계정 생성 · 레코드
// 연결 · 근로계약 서명 대기 · 접속 상태가 한 흐름이고, 만 19세 미만의 가입 불가 · 운영 알림과 이메일 고유 제약은 목으로는
// 증명되지 않는다.
describe('직원 가입 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let secret: string;

  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let adminId: number;
  const staffIds: number[] = [];
  const emails: string[] = [];

  let seq = 0;
  const nextPhone = () =>
    `010${String(n).padStart(6, '0')}${String(seq++ % 100).padStart(2, '0')}`;

  /** 가입 초대가 나가 가입을 기다리는 직원 — 레코드 · 초대(코드 · 링크 토큰) · 발송 대기 계약 */
  async function invited(storeId: number, options: { expiresAt?: Date } = {}) {
    const code = newInvitationCode();
    const token = randomBytes(32).toString('base64url');
    const phone = nextPhone();
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '홍길동',
        phone,
        employmentType: 'PART_TIME',
        jobTitle: '매장',
        joinStatus: 'INVITED',
      },
    });
    staffIds.push(staff.staffMemberId);
    const now = new Date();
    const { invitationId } = await prisma.invitation.create({
      data: {
        staffMemberId: staff.staffMemberId,
        invitationType: 'SIGNUP',
        invitationToken: hashToken(token),
        invitationCodeHash: hashInvitationCode(code, secret),
        channel: 'ALIMTALK',
        sentAt: now,
        expiresAt:
          options.expiresAt ?? new Date(now.getTime() + 30 * 86_400_000),
        status: 'SENT',
      },
    });
    const contract = await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: addDays(kstToday(), 1),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'PENDING_SEND',
        createdBy: adminId,
      },
    });
    return {
      code,
      token,
      phone,
      invitationId,
      staffMemberId: staff.staffMemberId,
      contractId: contract.contractId,
    };
  }

  const body = (lookup: object, overrides: Record<string, unknown> = {}) => {
    const email = `signup${n}-${seq++}@whale.test`;
    emails.push(email);
    return {
      ...lookup,
      email,
      password: 'Whale2026!',
      name: '홍길동',
      birthDate: '1995-03-02',
      gender: 'FEMALE',
      isForeigner: true,
      zipCode: '04001',
      address: '서울 마포구 동교로 1',
      addressDetail: '2층',
      deviceIdentifier: `e2e-${n}`,
      ...overrides,
    };
  };
  const post = (path: string, payload: object) =>
    request(app.getHttpServer()).post(path).send(payload);

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    secret = process.env.JWT_SECRET ?? '';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '가입 테스트 BP',
      },
    }));
    ({ storeId: directStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '가입 테스트 직영점',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ storeId: franchiseStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 1) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '가입 테스트 가맹점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `signup${n}`,
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
    const byStaff = { staffMemberId: { in: staffIds } };
    const notifications = await prisma.notification.findMany({
      where: { relatedType: 'STAFF_MEMBER', relatedId: { in: staffIds } },
      select: { notificationId: true },
    });
    const notificationIds = notifications.map((x) => x.notificationId);
    await prisma.notificationRecipient.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notification.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.contractStatusHistory.deleteMany({
      where: { contract: byStaff },
    });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.invitation.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    const accounts = await prisma.account.findMany({
      where: { email: { in: emails } },
      select: { accountId: true },
    });
    const accountIds = accounts.map((a) => a.accountId);
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.loginHistory.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  it('번호 + 코드로 확인 → 가입하면 로그인된 상태 — 계정 · 레코드 연결 · 초대 수락 · 계약서 서명 대기', async () => {
    const s = await invited(directStoreId);
    const lookup = { phone: s.phone, code: s.code.toLowerCase() };
    const checked = await post(
      '/auth/account/invitations/check',
      lookup,
    ).expect(200);
    expect(checked.body).toMatchObject({
      storeName: '가입 테스트 직영점',
      employmentType: 'PART_TIME',
      phone: s.phone,
      asksHqSharingConsent: false,
    });

    const payload = body(lookup);
    const joined = await post('/auth/account/signup', payload).expect(201);
    expect(joined.body).toMatchObject({
      account: { email: payload.email, realName: '홍길동', status: 'JOINED' },
    });
    // 받은 토큰으로 바로 들어간다
    await request(app.getHttpServer())
      .get('/auth/account/me')
      .set(
        'Authorization',
        `Bearer ${(joined.body as { accessToken: string }).accessToken}`,
      )
      .expect(200);

    const account = await prisma.account.findUniqueOrThrow({
      where: { email: payload.email },
    });
    expect(account).toMatchObject({
      phone: s.phone,
      gender: 'FEMALE',
      isForeigner: true,
      isHqSharingConsented: false,
      status: 'JOINED',
    });
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: s.staffMemberId },
      }),
    ).toMatchObject({ accountId: account.accountId, joinStatus: 'JOINED' });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: s.invitationId },
      }),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(
      await prisma.contract.findUniqueOrThrow({
        where: { contractId: s.contractId },
      }),
    ).toMatchObject({ status: 'PENDING_SIGNATURE' });
    expect(
      await prisma.contractStatusHistory.findMany({
        where: { contractId: s.contractId },
        select: { fromStatus: true, toStatus: true, actor: true },
      }),
    ).toEqual([
      {
        fromStatus: 'PENDING_SEND',
        toStatus: 'PENDING_SIGNATURE',
        actor: 'STAFF',
      },
    ]);

    // 가입을 마친 초대는 로그인으로 — 링크도 코드도
    const again = await post('/auth/account/invitations/check', {
      token: s.token,
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'INVITATION_ALREADY_JOINED' });
  });

  it('링크 토큰으로 확인 · 가입하고, 가맹점에서 동의하면 계정에 남는다', async () => {
    const s = await invited(franchiseStoreId);
    await post('/auth/account/invitations/check', { token: s.token })
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({
          storeName: '가입 테스트 가맹점',
          phone: s.phone,
          asksHqSharingConsent: true,
        }),
      );
    const payload = body({ token: s.token }, { hqSharingConsented: true });
    await post('/auth/account/signup', payload).expect(201);
    const account = await prisma.account.findUniqueOrThrow({
      where: { email: payload.email },
    });
    expect(account).toMatchObject({
      phone: s.phone,
      isHqSharingConsented: true,
      hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
    });
    expect(account.hqSharingAgreedAt).toBeInstanceOf(Date);
  });

  it('번호나 코드가 틀리면 404 INVITATION_NOT_FOUND, 끝난 초대는 404 INVITATION_ENDED', async () => {
    const s = await invited(directStoreId);
    const other = await invited(directStoreId);
    // 남의 코드 · 내 번호
    const mismatch = await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: other.code,
    }).expect(404);
    expect(mismatch.body).toMatchObject({ code: 'INVITATION_NOT_FOUND' });

    const expired = await invited(directStoreId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const ended = await post('/auth/account/invitations/check', {
      phone: expired.phone,
      code: expired.code,
    }).expect(404);
    expect(ended.body).toMatchObject({ code: 'INVITATION_ENDED' });
  });

  it('그 번호로 계정이 있으면 409 ACCOUNT_EXISTS — 가입하지 않는다', async () => {
    const first = await invited(directStoreId);
    await post(
      '/auth/account/signup',
      body({ phone: first.phone, code: first.code }),
    ).expect(201);
    // 같은 번호로 다른 점포에서 받은 초대(동시에 두 점포)
    const second = await invited(franchiseStoreId);
    await prisma.staffMember.update({
      where: { staffMemberId: second.staffMemberId },
      data: { phone: first.phone },
    });
    const res = await post('/auth/account/invitations/check', {
      phone: first.phone,
      code: second.code,
    }).expect(409);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });

  it('만 19세 미만이면 계정 없이 초대가 가입 불가가 되고 점포 관리자에게 운영 알림', async () => {
    const s = await invited(directStoreId);
    const today = kstToday().toISOString().slice(0, 10);
    const [y, m, d] = today.split('-');
    const res = await post(
      '/auth/account/signup',
      body({ token: s.token }, { birthDate: `${Number(y) - 18}-${m}-${d}` }),
    ).expect(400);
    expect(res.body).toMatchObject({ code: 'SIGNUP_UNDER_AGE' });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: s.invitationId },
      }),
    ).toMatchObject({ status: 'REJECTED_UNDER_AGE' });
    expect(await prisma.account.count({ where: { phone: s.phone } })).toBe(0);
    const notice = await prisma.notification.findFirst({
      where: {
        templateCode: 'NTF_SIGNUP_UNDER_AGE',
        relatedType: 'STAFF_MEMBER',
        relatedId: s.staffMemberId,
      },
      include: { notificationRecipients: true },
    });
    expect(notice).not.toBeNull();
    expect(
      notice!.notificationRecipients.map((r) => r.adminAccountId),
    ).toContain(adminId);
  });

  it('쓰는 이메일이면 409 — 초대 · 레코드는 그대로', async () => {
    const s = await invited(directStoreId);
    const taken = await post('/auth/account/signup', {
      ...body({ token: s.token }),
      email: emails[0],
    }).expect(409);
    expect(taken.body).toMatchObject({ code: 'ACCOUNT_EMAIL_TAKEN' });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: s.invitationId },
      }),
    ).toMatchObject({ status: 'SENT' });
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: s.staffMemberId },
      }),
    ).toMatchObject({ accountId: null, joinStatus: 'INVITED' });
  });
});
