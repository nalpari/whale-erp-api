import { randomBytes, randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { ContractStatus, EmploymentStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import {
  encryptPersonalData,
  staffTaxProfileAad,
} from '../src/common/personal-data-cipher';
import type {
  MyMembershipListResponseDto,
  MyTaxProfileResponseDto,
} from '../src/my-profile/dto/my-membership.response.dto';
import type { MyProfileResponseDto } from '../src/my-profile/dto/my-profile.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 직원 앱 내 정보(GET /me/profile) · 소속 근무지(GET /me/memberships) · 소속의 신고 정보를 실제 DB 로 확인한다 — 소속
// 고르기(체결 완료 · 가입 완료 · 퇴직 전, 임시저장만 있는 레코드 제외), 남의 레코드를 경로 id 로 열 수 없는지, 신고 정보
// 복호화 · 가림, 계정의 본사 제공 동의, 관리자 토큰 403.
describe('내 정보 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  // 키가 비어 있으면 이 테스트용 키를 쓴다. 앱이 뜨기 전에 넣어야 ConfigService 가 읽는다.
  process.env.PERSONAL_DATA_ENCRYPTION_KEY ||=
    randomBytes(32).toString('base64');
  const key = Buffer.from(process.env.PERSONAL_DATA_ENCRYPTION_KEY, 'base64');

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let bmId: number;
  let meId: number;
  let otherId: number;
  let withdrawnId: number;
  /** 내 레코드: 가맹 재직(신고 정보 있음) · 직영 퇴직 예정 · 임시저장만 · 퇴직. 남의 레코드 하나 */
  let franchiseStaffId: number;
  let directStaffId: number;
  let draftStaffId: number;
  let retiredStaffId: number;
  let otherStaffId: number;
  const staffIds: number[] = [];
  const accountIds: number[] = [];

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
        tradeName: '내 정보 테스트 BP',
      },
    }));
    const store = (offset: number, storeTypeCode: string) =>
      prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId,
          storeTypeCode,
          name: `내정보 ${storeTypeCode}`,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ storeId: directStoreId } = await store(0, 'DIRECT'));
    ({ storeId: franchiseStoreId } = await store(1, 'FRANCHISE'));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `me${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    meId = await account('나', 'JOINED');
    otherId = await account('남', 'JOINED');
    withdrawnId = await account('탈퇴', 'WITHDRAWN');

    await prisma.account.update({
      where: { accountId: meId },
      data: {
        isHqSharingConsented: true,
        hqSharingConsentVersion: 'v1',
        hqSharingAgreedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    franchiseStaffId = await staff(meId, franchiseStoreId, {
      hiredDate: new Date('2026-09-01'),
    });
    directStaffId = await staff(meId, directStoreId, {
      hiredDate: new Date('2026-08-01'),
      retiredDate: new Date('2026-12-31'),
    });
    draftStaffId = await staff(meId, directStoreId, {
      contractStatus: 'DRAFT',
    });
    retiredStaffId = await staff(meId, directStoreId, {
      employmentStatus: 'RETIRED',
      retiredDate: new Date('2026-09-30'),
    });
    otherStaffId = await staff(otherId, franchiseStoreId);

    for (const staffMemberId of [franchiseStaffId, retiredStaffId])
      await prisma.staffTaxProfile.create({
        data: {
          staffMemberId,
          rrnEncrypted: encryptPersonalData(
            key,
            '9803041234567',
            staffTaxProfileAad('rrn_encrypted', staffMemberId),
          ),
          bankCode: '088',
          payrollAccountNumberEncrypted: encryptPersonalData(
            key,
            '110123456789',
            staffTaxProfileAad(
              'payroll_account_number_encrypted',
              staffMemberId,
            ),
          ),
          purpose: '취득 신고 · 원천징수 · 급여 이체',
        },
      });
    await prisma.locationConsent.create({
      data: {
        accountId: meId,
        consentVersion: 'v1.0',
        pausedAt: new Date(),
      },
    });
  });

  async function account(name: string, status: 'JOINED' | 'WITHDRAWN') {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `me-${n}@test.invalid`,
        passwordHash: '!',
        realName: name,
        birthDate: new Date('1998-03-04'),
        phone: `010${n}`,
        zipCode: '06236',
        address: '서울 강남구 테헤란로 1',
        addressDetail: '3층',
        status,
      },
    });
    accountIds.push(accountId);
    return accountId;
  }

  async function staff(
    accountId: number,
    storeId: number,
    {
      hiredDate = null,
      retiredDate = null,
      employmentStatus = 'EMPLOYED',
      contractStatus = 'SIGNED',
    }: {
      hiredDate?: Date | null;
      retiredDate?: Date | null;
      employmentStatus?: EmploymentStatus;
      contractStatus?: ContractStatus;
    } = {},
  ) {
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '직원',
        phone: '01000000000',
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        hiredDate,
        retiredDate,
        employmentStatus,
        joinStatus: 'JOINED',
      },
    });
    staffIds.push(staffMemberId);
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: new Date('2026-08-01'),
        endDate: null,
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: contractStatus,
        createdBy: bmId,
      },
    });
    return staffMemberId;
  }

  afterAll(async () => {
    if (!prisma) return;
    await prisma.staffTaxProfile.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.contract.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.locationConsent.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const adminToken = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: bmId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: bmId,
            type: 'admin',
            loginId: `admin${bmId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  const accountToken = async (accountId: number) => {
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: `me-e2e-${accountId}` });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const taxPath = (staffMemberId: number | string) =>
    `/me/memberships/${staffMemberId}/tax-profile`;

  it('토큰이 없으면 401, 관리자 토큰은 403 — 세 경로 모두', async () => {
    const admin = await adminToken();
    for (const path of [
      '/me/profile',
      '/me/memberships',
      taxPath(franchiseStaffId),
    ]) {
      await get(path).expect(401);
      await get(path, admin).expect(403);
    }
  });

  it('내 정보 — 계정 칸, 계정의 본사 제공 동의, 위치정보 동의. 소속은 싣지 않는다', async () => {
    const res = await get('/me/profile', await accountToken(meId)).expect(200);
    const body = res.body as MyProfileResponseDto;
    expect(body).toMatchObject({
      accountId: meId,
      realName: '나',
      birthDate: '1998-03-04',
      zipCode: '06236',
      address: '서울 강남구 테헤란로 1',
      addressDetail: '3층',
      status: 'JOINED',
      hqSharingConsent: {
        isConsented: true,
        consentVersion: 'v1',
        agreedAt: '2026-10-01T00:00:00.000Z',
        withdrawnAt: null,
      },
      locationConsent: {
        state: 'PAUSED',
        consentVersion: 'v1.0',
        withdrawnAt: null,
      },
    });
    expect(body).not.toHaveProperty('memberships');
  });

  it('소속 근무지 — 내 재직 레코드만, 임시저장만 · 퇴직 · 남의 레코드는 빠지고 퇴직 예정은 들어간다', async () => {
    const res = await get('/me/memberships', await accountToken(meId)).expect(
      200,
    );
    const body = res.body as MyMembershipListResponseDto;
    expect(body.total).toBe(2);
    expect(body.items.map((m) => m.staffMemberId)).toEqual([
      directStaffId,
      franchiseStaffId,
    ]); // 입사일 순
    expect(body.items[0]).toEqual({
      staffMemberId: directStaffId,
      store: {
        storeId: directStoreId,
        storeName: '내정보 DIRECT',
        storeTypeCode: 'DIRECT',
      },
      employmentType: 'PART_TIME',
      jobTitle: '홀',
      hiredDate: '2026-08-01',
      retiredDate: '2026-12-31',
    });
    expect(body.items[1]).toMatchObject({
      hiredDate: '2026-09-01',
      retiredDate: null,
      store: { storeId: franchiseStoreId, storeTypeCode: 'FRANCHISE' },
    });
  });

  it('소속의 신고 정보 — 가린 값만, 원문은 응답에 없다. 내지 않은 소속은 null', async () => {
    const token = await accountToken(meId);
    const res = await get(taxPath(franchiseStaffId), token).expect(200);
    expect(res.body).toEqual({
      staffMemberId: franchiseStaffId,
      taxProfile: {
        rrnMasked: '980304-1******',
        bankCode: '088',
        payrollAccountNumberMasked: '********6789',
        purpose: '취득 신고 · 원천징수 · 급여 이체',
        collectedAt: expect.any(String) as string,
      },
    });
    expect(res.text).not.toContain('9803041234567');
    expect(res.text).not.toContain('110123456789');

    const none = await get(taxPath(directStaffId), token).expect(200);
    expect((none.body as MyTaxProfileResponseDto).taxProfile).toBeNull();
  });

  it('내 소속이 아닌 id 는 404 — 남의 레코드, 퇴직 · 임시저장만 있는 내 레코드, 범위 밖 id', async () => {
    const token = await accountToken(meId);
    for (const id of [
      otherStaffId,
      retiredStaffId, // 신고 정보가 있어도 소속이 아니다
      draftStaffId,
      '2147483648',
      'abc',
    ])
      await get(taxPath(id), token).expect(404);
  });

  it('남의 토큰으로는 그 사람 것만 — 내 소속 · 신고 정보 · 동의가 보이지 않는다', async () => {
    const token = await accountToken(otherId);
    const profile = (await get('/me/profile', token).expect(200))
      .body as MyProfileResponseDto;
    expect(profile.accountId).toBe(otherId);
    expect(profile.hqSharingConsent.isConsented).toBe(false);
    expect(profile.locationConsent.state).toBe('NOT_AGREED');
    const list = (await get('/me/memberships', token).expect(200))
      .body as MyMembershipListResponseDto;
    expect(list.items.map((m) => m.staffMemberId)).toEqual([otherStaffId]);
    await get(taxPath(franchiseStaffId), token).expect(404);
  });

  it('탈퇴 계정은 401', async () => {
    const token = await accountToken(withdrawnId);
    await get('/me/profile', token).expect(401);
    await get('/me/memberships', token).expect(401);
  });
});
