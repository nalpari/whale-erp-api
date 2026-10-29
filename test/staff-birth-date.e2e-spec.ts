import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 직원 생년월일 정정(WHALEERP-602)을 실제 DB 로 확인한다. 계정 하나가 여러 BP 소속에 걸쳐 같이 바뀌는 것, 이력이 같은
// 트랜잭션에 남는 것, 계약서 값이 그대로인 것은 목으로는 증명되지 않는다.
describe('직원 생년월일 정정 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let storeId: number;
  let otherBpCodeId: number;
  let otherBpStoreId: number;
  /** 소속 BP 전체 점포를 관리하는 BM */
  let adminId: number;
  /** 다른 BP 의 관리자 — 이 BP 직원은 범위 밖이다 */
  let outsiderAdminId: number;
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const contractIds: number[] = [];
  const adminIds: number[] = [];
  const roleGroupIds: number[] = [];
  /** 직원 정보 관리 조회만 켜고 수정은 끈 권한 그룹의 관리자(범위는 전체 점포) */
  let readOnlyAdminId: number;

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

    const n = randomInt(100_000, 999_998);
    const makeBp = async (suffix: number) => {
      const bp = await prisma.bpCode.create({
        data: {
          bpCode: `BP${n + suffix}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: `생년월일 테스트 BP ${suffix}`,
        },
      });
      const store = await prisma.store.create({
        data: {
          storeCode: `ST${n + suffix}`,
          bpCodeId: bp.bpCodeId,
          storeTypeCode: 'DIRECT',
          name: `생년월일 테스트 점포 ${suffix}`,
          storeStatusCode: 'OPERATING',
        },
      });
      return { bpCodeId: bp.bpCodeId, storeId: store.storeId };
    };
    ({ bpCodeId, storeId } = await makeBp(0));
    ({ bpCodeId: otherBpCodeId, storeId: otherBpStoreId } = await makeBp(1));

    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    const makeAdmin = async (bp: number, name: string) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${name}${n}`,
          bpCodeId: bp,
          passwordHash: '!',
          roleTypeCode: 'BM',
          roleGroupId: roleGroup.roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    adminId = await makeAdmin(bpCodeId, 'bdate');
    outsiderAdminId = await makeAdmin(otherBpCodeId, 'bdateout');

    const staffMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000005' },
    });
    const { roleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${String(n % 1_000_000).padStart(6, '0')}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `생년월일 읽기 전용 ${n}`,
        menus: {
          create: {
            menuId: staffMenu.menuId,
            isReadable: true,
            isUpdatable: false,
          },
        },
      },
    });
    roleGroupIds.push(roleGroupId);
    ({ adminAccountId: readOnlyAdminId } = await prisma.adminAccount.create({
      data: {
        loginId: `bdatero${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BA',
        roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    adminIds.push(readOnlyAdminId);
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.contractParty.deleteMany({
      where: { contractId: { in: contractIds } },
    });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.accountChangeHistory.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    const ids = adminIds.filter((id) => id !== undefined);
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: ids } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: ids } },
    });
    await prisma.roleGroupMenu.deleteMany({
      where: { roleGroupId: { in: roleGroupIds } },
    });
    await prisma.roleGroup.deleteMany({
      where: { roleGroupId: { in: roleGroupIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [storeId, otherBpStoreId] } },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpCodeId] } },
    });
    await app.close();
  });

  async function createAccount(
    birth = '1990-05-17',
    status: 'JOINED' | 'WITHDRAWN' = 'JOINED',
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `bdate-${n}@test.invalid`,
        passwordHash: '!',
        realName: '홍길동',
        birthDate: new Date(birth),
        phone: `010${n}`,
        status,
      },
    });
    accountIds.push(accountId);
    return accountId;
  }

  async function createStaff(
    accountId: number | null,
    over: {
      store?: number;
      employmentStatus?: 'EMPLOYED' | 'RETIRED';
      retiredDate?: Date | null;
    } = {},
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    const staff = await prisma.staffMember.create({
      data: {
        storeId: over.store ?? storeId,
        accountId,
        name: '홍길동',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: accountId === null ? 'DRAFT' : 'JOINED',
        employmentStatus: over.employmentStatus ?? 'EMPLOYED',
        retiredDate: over.retiredDate ?? null,
      },
    });
    staffIds.push(staff.staffMemberId);
    return staff.staffMemberId;
  }

  const tokenOf = async (sub: number) =>
    (
      await app.get(AdminSessionService).issue({ adminAccountId: sub }, (sid) =>
        app.get(JwtService).signAsync({
          sub,
          type: 'admin',
          loginId: `admin${sub}`,
          typ: 'access',
          sid,
        }),
      )
    ).accessToken;

  const put = async (staffId: number, birthDate: unknown, as = adminId) =>
    request(app.getHttpServer())
      .put(`/staff-members/${staffId}/birth-date`)
      .set('Authorization', `Bearer ${await tokenOf(as)}`)
      .send({ birthDate });

  const correctableOf = async (staffId: number) =>
    (
      (
        await request(app.getHttpServer())
          .get(`/staff-members/${staffId}`)
          .set('Authorization', `Bearer ${await tokenOf(adminId)}`)
      ).body as { birthDateCorrectable: boolean }
    ).birthDateCorrectable;

  const birthOf = async (accountId: number) =>
    (await prisma.account.findUniqueOrThrow({ where: { accountId } })).birthDate
      .toISOString()
      .slice(0, 10);

  it('성공 204 — 계정 값이 바뀌고, 다른 BP 소속에도 같이 바뀌고, 이력이 남고, 계약서 값은 그대로다', async () => {
    const accountId = await createAccount('1990-05-17');
    const staffId = await createStaff(accountId);
    const otherBpStaffId = await createStaff(accountId, {
      store: otherBpStoreId,
    });
    // 날인 대기 중인 계약 — 막지 않고, 그 계약서의 생년월일 값은 바꾸지 않는다.
    const contract = await prisma.contract.create({
      data: {
        staffMemberId: staffId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: new Date('2026-11-01'),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'PENDING_SIGNATURE',
        createdBy: adminId,
      },
    });
    contractIds.push(contract.contractId);
    await prisma.contractParty.create({
      data: {
        contractId: contract.contractId,
        enteredBirthDate: new Date('1990-05-17'),
        verifiedBirthDate: '1990-05-17',
      },
    });

    const res = await put(staffId, '1991-06-18');

    expect(res.status).toBe(204);
    expect(await birthOf(accountId)).toBe('1991-06-18');
    // 다른 BP 소속 레코드는 같은 계정을 가리킨다.
    const sibling = await prisma.staffMember.findUniqueOrThrow({
      where: { staffMemberId: otherBpStaffId },
      select: { account: { select: { birthDate: true } } },
    });
    expect(sibling.account?.birthDate.toISOString().slice(0, 10)).toBe(
      '1991-06-18',
    );
    const histories = await prisma.accountChangeHistory.findMany({
      where: { accountId },
    });
    expect(histories).toHaveLength(1);
    expect(histories[0]).toMatchObject({
      field: 'BIRTH_DATE',
      beforeValue: '1990-05-17',
      afterValue: '1991-06-18',
      channel: 'ADMIN_CORRECTION',
      requestedBy: adminId,
    });
    const party = await prisma.contractParty.findUniqueOrThrow({
      where: { contractId: contract.contractId },
    });
    expect(party.enteredBirthDate?.toISOString().slice(0, 10)).toBe(
      '1990-05-17',
    );
    expect(party.verifiedBirthDate).toBe('1990-05-17');
  });

  // 권한 판정이 범위 판정보다 먼저여야 한다 — 권한 없는 관리자가 응답만으로 그 id 가 자기 범위 직원인지 알면 안 된다.
  it('수정 권한이 없으면 없는 id · 범위 밖 · 범위 안 직원 모두 같은 403 이고 값 · 이력이 그대로다', async () => {
    const accountId = await createAccount('1990-05-17');
    const inScope = await createStaff(accountId);
    const outAccount = await createAccount('1990-05-17');
    const outOfScope = await createStaff(outAccount, { store: otherBpStoreId });

    const results: Awaited<ReturnType<typeof put>>[] = [];
    for (const id of [2_147_483_647, outOfScope, inScope])
      results.push(await put(id, '1991-06-18', readOnlyAdminId));

    expect(results.map((r) => r.status)).toEqual([403, 403, 403]);
    for (const r of results) expect(r.body).toEqual(results[0].body);
    expect(await birthOf(accountId)).toBe('1990-05-17');
    expect(await birthOf(outAccount)).toBe('1990-05-17');
    expect(
      await prisma.accountChangeHistory.count({
        where: { accountId: { in: [accountId, outAccount] } },
      }),
    ).toBe(0);
  });

  it('관리 범위 밖(다른 BP) 직원은 404 이고 값이 바뀌지 않는다', async () => {
    const accountId = await createAccount('1990-05-17');
    const staffId = await createStaff(accountId);

    const res = await put(staffId, '1991-06-18', outsiderAdminId);

    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe(
      '직원을 찾을 수 없습니다.',
    );
    expect(await birthOf(accountId)).toBe('1990-05-17');
    expect(
      await prisma.accountChangeHistory.count({ where: { accountId } }),
    ).toBe(0);
  });

  it('퇴직한 레코드는 409 BIRTH_DATE_RETIRED, 퇴직 예정(재직)은 204', async () => {
    const accountId = await createAccount('1990-05-17');
    const retiredId = await createStaff(accountId, {
      employmentStatus: 'RETIRED',
      retiredDate: addDays(kstToday(), -3),
    });

    expect(await correctableOf(retiredId)).toBe(false);
    const res = await put(retiredId, '1991-06-18');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'BIRTH_DATE_RETIRED',
      message: '퇴직한 직원은 생년월일을 정정할 수 없습니다.',
    });
    expect(await birthOf(accountId)).toBe('1990-05-17');

    // 퇴직일이 지났는데 배치가 아직 RETIRED 로 바꾸지 않은 레코드도 막는다.
    const pendingBatchAccount = await createAccount('1990-05-17');
    const pendingBatchId = await createStaff(pendingBatchAccount, {
      retiredDate: addDays(kstToday(), -1),
    });
    expect(await correctableOf(pendingBatchId)).toBe(false);
    const pending = await put(pendingBatchId, '1991-06-18');
    expect(pending.status).toBe(409);
    expect((pending.body as { code: string }).code).toBe('BIRTH_DATE_RETIRED');
    expect(await birthOf(pendingBatchAccount)).toBe('1990-05-17');

    const scheduledAccount = await createAccount('1990-05-17');
    const scheduledId = await createStaff(scheduledAccount, {
      retiredDate: addDays(kstToday(), 10),
    });
    expect(await correctableOf(scheduledId)).toBe(true);
    expect((await put(scheduledId, '1991-06-18')).status).toBe(204);
    expect(await birthOf(scheduledAccount)).toBe('1991-06-18');
  });

  it('만 19세 미만 · 오늘 이후 · 형식 오류는 400 이다', async () => {
    const accountId = await createAccount('1990-05-17');
    const staffId = await createStaff(accountId);
    const today = kstToday().toISOString().slice(0, 10);

    const under = await put(staffId, today);
    expect(under.status).toBe(400);
    expect(under.body).toMatchObject({
      code: 'BIRTH_DATE_UNDER_AGE',
      message: '만 19세 미만으로 정정할 수 없습니다.',
    });
    const future = await put(
      staffId,
      addDays(kstToday(), 1).toISOString().slice(0, 10),
    );
    expect(future.body).toMatchObject({
      code: 'BIRTH_DATE_INVALID',
      message: '오늘 이후 날짜는 넣을 수 없습니다.',
    });
    expect(
      ((await put(staffId, '1990-02-30')).body as { code: string }).code,
    ).toBe('BIRTH_DATE_INVALID');
    expect((await put(staffId, 19900517)).status).toBe(400);
    expect(await birthOf(accountId)).toBe('1990-05-17');
  });

  it('가입 전(계정 없음) · 탈퇴 계정은 409 BIRTH_DATE_NOT_JOINED, 같은 값은 409 BIRTH_DATE_UNCHANGED', async () => {
    const draftId = await createStaff(null);
    const draft = await put(draftId, '1991-06-18');
    expect(draft.status).toBe(409);
    expect((draft.body as { code: string }).code).toBe('BIRTH_DATE_NOT_JOINED');

    const withdrawn = await createAccount('1990-05-17', 'WITHDRAWN');
    const withdrawnId = await createStaff(withdrawn);
    expect(
      ((await put(withdrawnId, '1991-06-18')).body as { code: string }).code,
    ).toBe('BIRTH_DATE_NOT_JOINED');

    const accountId = await createAccount('1990-05-17');
    const staffId = await createStaff(accountId);
    const same = await put(staffId, '1990-05-17');
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({
      code: 'BIRTH_DATE_UNCHANGED',
      message: '지금 생년월일과 같습니다.',
    });
    expect(
      await prisma.accountChangeHistory.count({ where: { accountId } }),
    ).toBe(0);
  });
});
