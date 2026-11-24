import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBp, deleteBps } from './hq-bp';

// 직원 앱 회원 탈퇴(WHALEERP-770)를 실제 DB 로 확인한다 — 재직 거절(409 · 퇴직 예정 포함), 비밀번호 400, 탈퇴 때 지우는 것 ·
// 남기는 것, 대기 계약 종료 이력, 세션 폐기, 근무지 관리자 알림, 같은 이메일 재가입, 관리자웹 isAccountWithdrawn.
describe('직원 앱 회원 탈퇴 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const PASSWORD = 'OldPass123!';

  let bpCodeId: number;
  let storeId: number;
  let otherStoreId: number;
  let adminId: number;
  let passwordHash: string;
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
    passwordHash = await hashPassword(PASSWORD);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await createBp(prisma, {
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '탈퇴 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '탈퇴 테스트 직영점',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ storeId: otherStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${n === 999_999 ? 100_000 : n + 1}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '탈퇴 테스트 둘째점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `wd${n}`,
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
    if (!prisma) return;
    const byStaff = { contract: { staffMemberId: { in: staffIds } } };
    await prisma.contractStatusHistory.deleteMany({ where: byStaff });
    await prisma.contractParty.deleteMany({ where: byStaff });
    await prisma.contract.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.invitation.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    const accountWhere = { accountId: { in: accountIds } };
    await prisma.locationAccessLog.deleteMany({ where: accountWhere });
    await prisma.locationConsentHistory.deleteMany({
      where: { locationConsent: accountWhere },
    });
    await prisma.locationConsent.deleteMany({ where: accountWhere });
    await prisma.loginHistory.deleteMany({ where: accountWhere });
    await prisma.accountChangeHistory.deleteMany({ where: accountWhere });
    await prisma.identityVerification.deleteMany({ where: accountWhere });
    await prisma.notificationPreference.deleteMany({ where: accountWhere });
    await prisma.emailChangePin.deleteMany({ where: accountWhere });
    await prisma.passwordResetPin.deleteMany({ where: accountWhere });
    await prisma.passwordResetLink.deleteMany({ where: accountWhere });
    await prisma.authSession.deleteMany({ where: accountWhere });
    await prisma.account.deleteMany({ where: accountWhere });
    // beforeAll 이 관리자를 만들기 전에 죽었으면 adminId 가 undefined 다 — Prisma 는 undefined 필터를 빼 전체 행을 지우므로 건너뛴다
    if (adminId !== undefined) {
      // 알림은 응답 전에 만들어지지만(notify 를 기다린 뒤 204) 이 관리자를 가리키는 받는 사람 행이 있어 지우다 걸릴 수 있다 — 지우다 걸리면 다시 한다
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: adminId },
      });
      for (let attempt = 1; ; attempt++) {
        const rows = await prisma.notificationRecipient.findMany({
          where: { adminAccountId: adminId },
          select: { notificationId: true },
        });
        await prisma.notificationRecipient.deleteMany({
          where: { adminAccountId: adminId },
        });
        await prisma.notification.deleteMany({
          where: { notificationId: { in: rows.map((r) => r.notificationId) } },
        });
        try {
          await prisma.adminAccount.deleteMany({
            where: { adminAccountId: adminId },
          });
          break;
        } catch (e) {
          if (attempt >= 20) throw e;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    // 점포 · BP 도 만들어진 것만 — undefined id 로 지우면 전체 행에 걸린다
    const storeIds = [storeId, otherStoreId].filter(
      (id): id is number => id !== undefined,
    );
    if (storeIds.length)
      await prisma.store.deleteMany({ where: { storeId: { in: storeIds } } });
    if (bpCodeId !== undefined)
      await deleteBps(prisma, { where: { bpCodeId } });
    await app?.close();
  });

  async function account() {
    const n = randomInt(10_000_000, 99_999_999);
    const created = await prisma.account.create({
      data: {
        email: `wd-${n}@test.invalid`,
        passwordHash,
        realName: '탈퇴자',
        birthDate: new Date('1995-03-02'),
        phone: `010${n}`,
        gender: 'FEMALE',
        zipCode: '04001',
        address: '서울 마포구 동교로 1',
        addressDetail: '2층',
        connectingInformation: `ci-${n}`,
        status: 'JOINED',
        isHqSharingConsented: true,
        hqSharingConsentVersion: 'v1.0',
        hqSharingAgreedAt: new Date(),
      },
    });
    accountIds.push(created.accountId);
    return { ...created, email: created.email!, phone: created.phone! };
  }

  async function staff(
    a: { accountId: number; phone: string },
    o: {
      link?: 'account' | 'candidate';
      store?: number;
      employment?: 'EMPLOYED' | 'RETIRED';
      retiredDate?: Date;
    } = {},
  ) {
    const link = o.link ?? 'account';
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId: o.store ?? storeId,
        name: '홍길동',
        phone: a.phone,
        employmentType: 'PART_TIME',
        jobTitle: '매장',
        joinStatus: link === 'account' ? 'JOINED' : 'INVITED',
        employmentStatus: o.employment ?? 'EMPLOYED',
        retiredDate: o.retiredDate ?? null,
        ...(link === 'account'
          ? { accountId: a.accountId }
          : { candidateAccountId: a.accountId }),
      },
    });
    staffIds.push(staffMemberId);
    return staffMemberId;
  }

  const session = async (accountId: number, device: string) => {
    const issued = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: `wd-e2e-${accountId}-${device}` });
    const token = await app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: issued.authSessionId,
    });
    return { token, sid: issued.authSessionId };
  };
  const eligibility = (token: string) =>
    request(app.getHttpServer())
      .get('/me/profile/withdrawal-eligibility')
      .set('Authorization', `Bearer ${token}`);
  const withdraw = (token: string, currentPassword: string) =>
    request(app.getHttpServer())
      .post('/me/profile/withdrawal')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword });
  const adminToken = async () =>
    (
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

  it('토큰이 없으면 401, 관리자 토큰은 403', async () => {
    const admin = await adminToken();
    await request(app.getHttpServer())
      .get('/me/profile/withdrawal-eligibility')
      .expect(401);
    await request(app.getHttpServer())
      .post('/me/profile/withdrawal')
      .send({ currentPassword: PASSWORD })
      .expect(401);
    await request(app.getHttpServer())
      .get('/me/profile/withdrawal-eligibility')
      .set('Authorization', `Bearer ${admin}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/me/profile/withdrawal')
      .set('Authorization', `Bearer ${admin}`)
      .send({ currentPassword: PASSWORD })
      .expect(403);
  });

  it('재직 중이면 조건 조회는 canWithdraw false, 탈퇴는 409 이고 아무것도 지우지 않는다 — 퇴직 예정은 퇴직일을 담는다', async () => {
    const a = await account();
    await staff(a);
    await staff(a, {
      employment: 'EMPLOYED',
      retiredDate: new Date('2027-01-31T00:00:00Z'),
    });
    const { token } = await session(a.accountId, 'a');

    const eligible = await eligibility(token).expect(200);
    expect(eligible.body).toEqual({
      canWithdraw: false,
      employedStores: [
        { storeName: '탈퇴 테스트 직영점', retiredDate: null },
        { storeName: '탈퇴 테스트 직영점', retiredDate: '2027-01-31' },
      ],
      pendingContractCount: 0,
    });

    const res = await withdraw(token, PASSWORD).expect(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'EMPLOYED_AFFILIATION',
      message: '근무지 관리자에게 퇴직 처리를 요청해 주세요.',
      employedStores: [
        { storeName: '탈퇴 테스트 직영점', retiredDate: null },
        { storeName: '탈퇴 테스트 직영점', retiredDate: '2027-01-31' },
      ],
    });
    const row = await prisma.account.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(row.status).toBe('JOINED');
    expect(row.email).toBe(a.email);
    // 접속도 그대로다
    await eligibility(token).expect(200);
  });

  it('지금 비밀번호가 틀리면 400 이고 로그인 실패 횟수는 세지 않는다', async () => {
    const a = await account();
    const { token } = await session(a.accountId, 'a');

    const res = await withdraw(token, 'WrongPass1!').expect(400);

    expect(res.body).toMatchObject({
      message: '지금 비밀번호가 맞지 않습니다.',
    });
    const row = await prisma.account.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(row.status).toBe('JOINED');
    expect(row.failedLoginCount).toBe(0);
  });

  it('퇴직한 레코드만 있으면 탈퇴한다 — 개인정보 · 위치정보 · 이력은 지우고 근로 기록은 남긴다', async () => {
    const a = await account();
    const retiredId = await staff(a, {
      employment: 'RETIRED',
      retiredDate: new Date('2026-06-30T00:00:00Z'),
    });
    // 다른 근무지가 소속 추가를 요청한 후보 레코드 — 서명 대기 계약 · 발송 초대 · 열린 연결 보류
    const candidateId = await staff(a, {
      link: 'candidate',
      store: otherStoreId,
    });
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: candidateId,
        storeId: otherStoreId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: new Date('2026-12-01'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'PENDING_SIGNATURE',
        sentAt: new Date(),
        signDeadlineAt: new Date(Date.now() + 30 * 86_400_000),
        createdBy: adminId,
      },
    });
    // 퇴직한 레코드의 체결 완료 계약은 건드리지 않는다
    const { contractId: signedId } = await prisma.contract.create({
      data: {
        staffMemberId: retiredId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-06-30'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'SIGNED',
        createdBy: adminId,
      },
    });
    const { invitationId } = await prisma.invitation.create({
      data: {
        staffMemberId: candidateId,
        invitationType: 'AFFILIATION_CONFIRM',
        channel: 'PUSH',
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        status: 'SENT',
      },
    });
    await prisma.linkHold.create({
      data: {
        invitationId,
        accountId: a.accountId,
        mismatchReason: 'PHONE_MISMATCH',
      },
    });
    const consent = await prisma.locationConsent.create({
      data: { accountId: a.accountId, consentVersion: 'v1' },
    });
    await prisma.locationConsentHistory.create({
      data: { locationConsentId: consent.locationConsentId, action: 'AGREE' },
    });
    await prisma.locationAccessLog.create({
      data: { accountId: a.accountId, action: 'COLLECT', method: 'GPS' },
    });
    await prisma.loginHistory.create({
      data: { accountId: a.accountId, email: a.email, isSucceeded: true },
    });
    await prisma.accountChangeHistory.create({
      data: {
        accountId: a.accountId,
        field: 'PHONE',
        beforeValue: '01000000000',
        afterValue: a.phone,
        channel: 'SELF',
      },
    });
    await prisma.identityVerification.create({
      data: {
        accountId: a.accountId,
        purpose: 'SIGNUP',
        phone: a.phone,
        result: 'SUCCEEDED',
      },
    });
    // 계정 없이 남은 같은 번호의 인증 기록 — 다른 사람의 것일 수 있어 남는다
    const orphan = await prisma.identityVerification.create({
      data: { purpose: 'SIGNUP', phone: a.phone, result: 'SUCCEEDED' },
    });
    await prisma.notificationPreference.create({
      data: { accountId: a.accountId, preferenceCategory: 'CONTRACT' },
    });
    await prisma.emailChangePin.create({
      data: {
        accountId: a.accountId,
        newEmail: 'new@test.invalid',
        pinHash: 'x',
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
    await prisma.passwordResetPin.create({
      data: {
        accountId: a.accountId,
        pinHash: 'x',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.passwordResetLink.create({
      data: {
        accountId: a.accountId,
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
        requestedBy: adminId,
      },
    });
    const first = await session(a.accountId, 'a');
    const second = await session(a.accountId, 'b');

    await eligibility(first.token)
      .expect(200)
      .expect((res) =>
        expect(res.body).toEqual({
          canWithdraw: true,
          employedStores: [],
          pendingContractCount: 1,
        }),
      );
    await withdraw(first.token, PASSWORD).expect(204);

    // 계정 행은 남고 개인정보 칸만 비었다
    const row = await prisma.account.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(row).toMatchObject({
      status: 'WITHDRAWN',
      email: null,
      passwordHash: null,
      realName: null,
      birthDate: null,
      phone: null,
      gender: null,
      isForeigner: false,
      connectingInformation: null,
      zipCode: null,
      address: null,
      addressDetail: null,
      isHqSharingConsented: false,
      hqSharingConsentVersion: null,
      hqSharingAgreedAt: null,
      hqSharingWithdrawnAt: null,
    });
    // 지우는 것
    const where = { accountId: a.accountId };
    expect(await prisma.locationAccessLog.count({ where })).toBe(0);
    expect(await prisma.locationConsent.count({ where })).toBe(0);
    expect(
      await prisma.locationConsentHistory.count({
        where: { locationConsentId: consent.locationConsentId },
      }),
    ).toBe(0);
    for (const count of [
      prisma.loginHistory.count({ where }),
      prisma.accountChangeHistory.count({ where }),
      prisma.identityVerification.count({ where }),
      prisma.notificationPreference.count({ where }),
      prisma.emailChangePin.count({ where }),
      prisma.passwordResetPin.count({ where }),
      prisma.passwordResetLink.count({ where }),
      prisma.linkHold.count({ where }),
    ])
      expect(await count).toBe(0);
    expect(
      await prisma.identityVerification.count({
        where: { identityVerificationId: orphan.identityVerificationId },
      }),
    ).toBe(1);
    await prisma.identityVerification.delete({
      where: { identityVerificationId: orphan.identityVerificationId },
    });
    // 대기 계약은 종료 — 이력 actor 는 직원
    expect(
      (await prisma.contract.findUniqueOrThrow({ where: { contractId } }))
        .status,
    ).toBe('ENDED');
    expect(
      await prisma.contractStatusHistory.findMany({
        where: { contractId },
        select: { fromStatus: true, toStatus: true, actor: true },
      }),
    ).toEqual([
      { fromStatus: 'PENDING_SIGNATURE', toStatus: 'ENDED', actor: 'STAFF' },
    ]);
    // 체결 완료 계약 · 직원 레코드는 남는다
    expect(
      (
        await prisma.contract.findUniqueOrThrow({
          where: { contractId: signedId },
        })
      ).status,
    ).toBe('SIGNED');
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: retiredId },
        select: { accountId: true, employmentStatus: true },
      }),
    ).toEqual({ accountId: a.accountId, employmentStatus: 'RETIRED' });
    // 초대 만료 · 후보 계정 비움
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { invitationId } }))
        .status,
    ).toBe('EXPIRED');
    expect(
      (
        await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId: candidateId },
        })
      ).candidateAccountId,
    ).toBeNull();
    // 모든 기기의 접속이 끝났다 — 기기 식별 정보도 비었다
    const sessions = await prisma.authSession.findMany({ where });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.revokedAt).not.toBeNull();
      expect(s.deviceIdentifier).toBeNull();
    }
    await eligibility(first.token).expect(401);
    await eligibility(second.token).expect(401);

    // 그 이메일로는 더 로그인할 수 없고, 같은 이메일로 새로 가입할 수 있다
    await request(app.getHttpServer())
      .post('/auth/account/login')
      .send({ email: a.email, password: PASSWORD })
      .expect(401);
    const reborn = await prisma.account.create({
      data: {
        email: a.email,
        passwordHash,
        realName: '탈퇴자',
        birthDate: new Date('1995-03-02'),
        phone: a.phone,
        status: 'JOINED',
      },
    });
    accountIds.push(reborn.accountId);

    // 근무지 관리자 알림 — 이어진 직원 레코드(퇴직한 것)의 근무지 + 대기 계약을 닫은 후보 레코드의 근무지
    const notices = await prisma.notificationRecipient.findMany({
      where: {
        adminAccountId: adminId,
        notification: { templateCode: 'NTF_STAFF_WITHDRAWN' },
      },
      orderBy: { notificationRecipientId: 'asc' },
      select: {
        notification: { select: { title: true, relatedId: true, link: true } },
      },
    });
    expect(notices.map((n) => n.notification)).toEqual([
      {
        title: '홍길동 님이 직원 앱 계정을 탈퇴했습니다.',
        relatedId: retiredId,
        link: `/staff-members/${retiredId}`,
      },
      {
        title: '홍길동 님이 직원 앱 계정을 탈퇴했습니다.',
        relatedId: candidateId,
        link: `/staff-members/${candidateId}`,
      },
    ]);

    // 관리자웹 직원 목록 · 상세 — 탈퇴 계정 표시, 이메일 · 생년월일은 없다
    const admin = await adminToken();
    const detail = await request(app.getHttpServer())
      .get(`/staff-members/${retiredId}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      staffMemberId: retiredId,
      isAccountWithdrawn: true,
      email: null,
      birthDate: null,
    });
    const list = await request(app.getHttpServer())
      .get('/staff-members')
      .query({ keyword: '홍길동' })
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    const listed = (
      list.body as {
        items: { staffMemberId: number; isAccountWithdrawn: boolean }[];
      }
    ).items.find((i) => i.staffMemberId === retiredId);
    expect(listed?.isAccountWithdrawn).toBe(true);
  });

  it('탈퇴한 계정이 다시 탈퇴를 부르면 401 이다', async () => {
    const a = await account();
    const { token } = await session(a.accountId, 'a');
    await withdraw(token, PASSWORD).expect(204);
    await withdraw(token, PASSWORD).expect(401);
  });
});
