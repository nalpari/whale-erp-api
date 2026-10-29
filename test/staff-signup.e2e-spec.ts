import { randomBytes, randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AlimtalkService } from '../src/alimtalk/alimtalk.service';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { hashToken } from '../src/auth/password';
import { invitationCodePhoneKeyOf } from '../src/auth/phone-key';
import {
  hashInvitationCode,
  newInvitationCode,
} from '../src/contracts/contract-delivery.service';
import { ContractSendService } from '../src/contracts/contract-send.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';
import type { MyInvitationListResponseDto } from '../src/staff-signup/dto/my-invitation.dto';

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

  type Invited = Awaited<ReturnType<typeof invited>> & { oldCode: string };

  /** 가입 초대가 나가 가입을 기다리는 직원 — 레코드 · 초대(코드 · 링크 토큰) · 발송 대기 계약 */
  async function invited(
    storeId: number,
    options: { expiresAt?: Date; phone?: string; name?: string } = {},
  ) {
    const code = newInvitationCode();
    const token = randomBytes(32).toString('base64url');
    const phone = options.phone ?? nextPhone();
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: options.name ?? '홍길동',
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
        // 계약에 고용 형태가 있으면 직무도 계약 값을 읽는다(pendingTermsOf, api #164)
        jobTitle: '매장',
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
    // 재발송(ContractSendService)이 가입 초대를 보낼 수 있게 — 앱을 만들기 전에 정한다. 알림톡 자체는 테스트에서 가로챈다
    process.env.STAFF_APP_URL = 'https://staff.whale.test';
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
    const phones = await prisma.staffMember.findMany({
      where: byStaff,
      select: { phone: true },
    });
    await prisma.invitationCodeAttempt.deleteMany({
      where: {
        phoneKey: {
          in: phones.map((p) => invitationCodePhoneKeyOf(secret, p.phone)),
        },
      },
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
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: adminId },
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

  it('두 점포의 가입 초대 — 한쪽으로 가입하면 다른 쪽은 ACCOUNT_EXISTS, 로그인 뒤 내 초대 목록에서 골라 근무지를 더한다(WHALEERP-603)', async () => {
    const first = await invited(directStoreId);
    const joined = await post(
      '/auth/account/signup',
      body({ phone: first.phone, code: first.code }),
    ).expect(201);
    const { accessToken } = joined.body as { accessToken: string };
    /** 같은 번호로 다른 점포에서 받은 초대 — sentAt 으로 목록 순서를 정한다 */
    const mine = async (storeId: number, sentAt: Date, expiresAt?: Date) => {
      const s = await invited(storeId, { phone: first.phone, expiresAt });
      await prisma.invitation.update({
        where: { invitationId: s.invitationId },
        data: { sentAt },
      });
      return s;
    };
    const hour = 3_600_000;
    const second = await mine(franchiseStoreId, new Date(Date.now() - hour));
    const older = await mine(directStoreId, new Date(Date.now() - 2 * hour));
    const expired = await mine(
      directStoreId,
      new Date(Date.now() - 3 * hour),
      new Date(Date.now() - 60_000),
    );
    const res = await post('/auth/account/invitations/check', {
      phone: first.phone,
      code: second.code,
    }).expect(409);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_EXISTS' });

    const authed = (method: 'get' | 'post', path: string) =>
      request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${accessToken}`);
    const accept = (invitationId: number | string, payload: object = {}) =>
      authed('post', `/me/invitations/${invitationId}/accept`).send(payload);

    // 목록은 소속 근무지 화면을 열 때마다 부른다 — 계정 축 한도(10분 10번)를 받지 않는다
    for (let i = 0; i < 11; i += 1)
      await authed('get', '/me/invitations').expect(200);

    // 남의 번호로 나간 초대는 목록에 없고, id 로도 잇지 못한다 — 상태(살아 있음 · 수락 · 끝남)와 상관없이 같은 404
    const stranger = await invited(franchiseStoreId);
    const strangerAccepted = await invited(franchiseStoreId);
    await prisma.invitation.update({
      where: { invitationId: strangerAccepted.invitationId },
      data: { status: 'ACCEPTED' },
    });
    const strangerEnded = await invited(franchiseStoreId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    // 같은 번호지만 근로계약서 이름이 계정 이름과 다르다 — 번호가 다른 사람에게 넘어간 경우로 본다(api #180 리뷰)
    const renamed = await invited(franchiseStoreId, {
      phone: first.phone,
      name: '김철수',
    });

    const listed = await authed('get', '/me/invitations').expect(200);
    const { items } = listed.body as MyInvitationListResponseDto;
    // 가입에 쓴 초대 · 끝난 초대 · 남의 초대 · 이름이 다른 초대는 없다. 보낸 때 최근 순
    expect(items.map((i) => i.invitationId)).toEqual([
      second.invitationId,
      older.invitationId,
    ]);
    expect(items[0]).toEqual({
      invitationId: second.invitationId,
      storeName: '가입 테스트 가맹점',
      employmentType: 'PART_TIME',
      jobTitle: '매장',
      sentAt: expect.any(String) as string,
      expiresAt: expect.any(String) as string,
      asksHqSharingConsent: true,
    });
    expect(items[1]).toMatchObject({
      storeName: '가입 테스트 직영점',
      asksHqSharingConsent: false,
    });

    // 계정 축 한도(10분 10번)가 수락에 걸려 이 시험의 수락 호출은 10번을 넘기지 않는다
    for (const other of [stranger, strangerAccepted, strangerEnded, renamed]) {
      const notMine = await accept(other.invitationId).expect(404);
      expect(notMine.body).toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    }
    for (const id of ['0', '2147483648']) {
      const bad = await accept(id).expect(404);
      expect(bad.body).toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    }
    const ended = await accept(expired.invitationId).expect(404);
    expect(ended.body).toMatchObject({ code: 'INVITATION_ENDED' });
    await accept(second.invitationId, { hqSharingConsented: 'yes' }).expect(
      400,
    );

    await accept(second.invitationId, { hqSharingConsented: true })
      .expect(200)
      .expect({
        staffMemberId: second.staffMemberId,
        storeName: '가입 테스트 가맹점',
      });

    const account = await prisma.account.findFirstOrThrow({
      where: { phone: first.phone },
    });
    expect(account).toMatchObject({
      isHqSharingConsented: true,
      hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
    });
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: second.staffMemberId },
      }),
    ).toMatchObject({ accountId: account.accountId, joinStatus: 'JOINED' });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: second.invitationId },
      }),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(
      await prisma.contract.findUniqueOrThrow({
        where: { contractId: second.contractId },
      }),
    ).toMatchObject({ status: 'PENDING_SIGNATURE' });
    expect(
      await prisma.contractStatusHistory.findMany({
        where: { contractId: second.contractId },
        select: { fromStatus: true, toStatus: true, actor: true },
      }),
    ).toEqual([
      {
        fromStatus: 'PENDING_SEND',
        toStatus: 'PENDING_SIGNATURE',
        actor: 'STAFF',
      },
    ]);
    // 더한 초대는 목록에서 빠지고, 한 번 더하면 가입을 마친 초대
    const after = await authed('get', '/me/invitations').expect(200);
    expect(
      (after.body as MyInvitationListResponseDto).items.map(
        (i) => i.invitationId,
      ),
    ).toEqual([older.invitationId]);
    expect((after.body as MyInvitationListResponseDto).total).toBe(1);
    const again = await accept(second.invitationId).expect(409);
    expect(again.body).toMatchObject({ code: 'INVITATION_ALREADY_JOINED' });
    // 이미 동의한 계정에는 가맹점이어도 묻지 않는다
    const franchiseAgain = await mine(franchiseStoreId, new Date());
    const asked = await authed('get', '/me/invitations').expect(200);
    expect((asked.body as MyInvitationListResponseDto).items[0]).toMatchObject({
      invitationId: franchiseAgain.invitationId,
      asksHqSharingConsent: false,
    });
  });

  it('내 초대 목록 · 더하기 — 토큰이 없으면 401, 관리자 토큰은 403', async () => {
    const { accessToken: admin } = await app
      .get(AdminSessionService)
      .issue({ adminAccountId: adminId }, (sid) =>
        app.get(JwtService).signAsync({
          sub: adminId,
          type: 'admin',
          loginId: `signup${n}`,
          typ: 'access',
          sid,
        }),
      );
    const server = app.getHttpServer();
    await request(server).get('/me/invitations').expect(401);
    await request(server).post('/me/invitations/1/accept').expect(401);
    await request(server)
      .get('/me/invitations')
      .set('Authorization', `Bearer ${admin}`)
      .expect(403);
    await request(server)
      .post('/me/invitations/1/accept')
      .set('Authorization', `Bearer ${admin}`)
      .send({})
      .expect(403);
  });

  it('같은 번호로 5번 틀리면 30분 잠기고 맞는 코드도 막힌다 — 다시 보내면(실패 0 행) 풀린다', async () => {
    const s = await invited(directStoreId);
    const wrong = s.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    for (let i = 0; i < 4; i++)
      await post('/auth/account/invitations/check', {
        phone: s.phone,
        code: wrong,
      }).expect(404);
    const locked = await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: wrong,
    }).expect(429);
    expect(locked.body).toMatchObject({ code: 'INVITATION_CODE_LOCKED' });
    const until = new Date(
      (locked.body as { lockExpiresAt: string }).lockExpiresAt,
    );
    expect(until.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: s.code,
    }).expect(429);

    // 관리자가 다시 보낸 것과 같은 행(ContractDeliveryService.prepare)
    await prisma.invitationCodeAttempt.create({
      data: {
        phoneKey: invitationCodePhoneKeyOf(secret, s.phone),
        isSucceeded: true,
        failedCount: 0,
        lockExpiresAt: null,
      },
    });
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: s.code,
    }).expect(200);
  });

  /**
   * 잠긴 번호로 재발송했는데 알림톡이 확실히 나가지 않은 경우 — 보내는 도중(`during`)에 그 번호로 무엇이 들어왔느냐에 따라
   * 되돌린 뒤 잠금이 되살아나는지 본다. 끝난 초대의 옛 코드를 하나 붙여 둔다.
   */
  async function resendFailingWhile(during: (s: Invited) => Promise<void>) {
    const s = await invited(directStoreId);
    const oldCode = newInvitationCode();
    await prisma.invitation.create({
      data: {
        staffMemberId: s.staffMemberId,
        invitationType: 'SIGNUP',
        invitationToken: hashToken(randomBytes(32).toString('base64url')),
        invitationCodeHash: hashInvitationCode(oldCode, secret),
        channel: 'ALIMTALK',
        sentAt: new Date(Date.now() - 40 * 86_400_000),
        expiresAt: new Date(Date.now() - 10 * 86_400_000),
        status: 'EXPIRED',
      },
    });
    const wrong = s.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    for (let i = 0; i < 4; i++)
      await post('/auth/account/invitations/check', {
        phone: s.phone,
        code: wrong,
      }).expect(404);
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: wrong,
    }).expect(429);
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: s.code,
    }).expect(429);

    const alimtalk = app.get(AlimtalkService);
    const fallback = jest
      .spyOn(alimtalk, 'hasSmsFallback')
      .mockReturnValue(true);
    // 이 재발송의 알림톡만 실패시킨다 — 보내는 도중 `during` 이 부르는 다른 재발송은 나간다
    const send = jest
      .spyOn(alimtalk, 'send')
      .mockImplementationOnce(async () => {
        await during({ ...s, oldCode });
        throw new Error('요청 전 검사 실패 — 나가지 않음');
      })
      .mockResolvedValue(undefined as never);
    try {
      await expect(
        app.get(ContractSendService).send(adminId, s.contractId),
      ).rejects.toMatchObject({ response: { code: 'SEND_FAILED' } });
    } finally {
      send.mockRestore();
      fallback.mockRestore();
    }
    return s;
  }

  it('재발송이 나가지 않아 되돌리면 잠금이 되살아난다 — 그사이 끝난 초대의 옛 코드가 들어왔어도(api #81 4차 리뷰)', async () => {
    const s = await resendFailingWhile(async ({ phone, oldCode }) => {
      // 해제 바로 뒤라 직전 상태(실패 0 · 잠금 없음)를 옮겨 적는 행이 쌓인다
      await post('/auth/account/invitations/check', {
        phone,
        code: oldCode,
      }).expect(404);
    });
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: s.code,
    }).expect(429);
  });

  it('재발송이 나가지 않아 되돌려도 그사이 다른 재발송이 푼 잠금은 남는다 — 그 요청으로 받은 코드가 막히지 않게(api #81 3차 리뷰)', async () => {
    let other: Invited | undefined;
    const s = await resendFailingWhile(async ({ phone }) => {
      // 같은 번호의 다른 계약을 실제로 재발송한다 — 그 요청이 쌓은 해제 행(prepare)에서 되돌리기가 멈춰야 한다
      const o = await invited(directStoreId, { phone });
      await app.get(ContractSendService).send(adminId, o.contractId);
      other = { ...o, oldCode: o.code };
    });
    expect(other).toBeDefined();
    // 그 재발송이 새로 낸 코드는 모르니, 해제가 남았는지는 잠금이 걸리지 않았는지로 본다(틀린 코드 404, 429 아님)
    await post('/auth/account/invitations/check', {
      phone: s.phone,
      code: s.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA',
    }).expect(404);
  });

  it('성별이 없으면 400 — 계정을 만들지 않고 초대도 그대로다(ACC-23 · JOI-10, 2026-10-21 재영)', async () => {
    const s = await invited(directStoreId);
    const res = await post(
      '/auth/account/signup',
      body({ token: s.token }, { gender: undefined }),
    ).expect(400);
    expect(JSON.stringify(res.body)).toContain('성별을 골라 주세요');
    expect(await prisma.account.count({ where: { phone: s.phone } })).toBe(0);
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: s.invitationId },
      }),
    ).toMatchObject({ status: 'SENT' });
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
